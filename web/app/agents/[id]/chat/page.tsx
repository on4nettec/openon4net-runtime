'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent, Conversation, Message } from '@o2n/shared';
import { AGENT_ROLE_CATALOG } from '@o2n/shared';
import { api, loadSession, streamChat, ApiError, type Session } from '@/lib/api-client';
import { applyDocumentDirection, isRtlLanguage, useLocaleStrings } from '@/lib/i18n';
import { Sidebar } from '@/components/Sidebar';

interface DisplayMessage {
  role: 'user' | 'agent';
  content: string;
  pending?: boolean;
  /** RT-084 — the reasoning/thinking trace behind this specific agent turn, if one was captured. */
  reasoning?: string;
}

/**
 * RT-084 — a 'thought' row is always immediately followed by the 'agent'
 * row it belongs to (chat-service.ts's persistTurn writes them in that
 * order within the same transaction), so pairing by position is reliable.
 * 'thought' rows are never rendered as their own bubble.
 */
function toDisplayMessages(history: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  let pendingReasoning: string | undefined;
  for (const m of history) {
    if (m.role === 'thought') {
      pendingReasoning = m.content;
    } else if (m.role === 'user' || m.role === 'agent') {
      result.push({
        role: m.role,
        content: m.content,
        ...(m.role === 'agent' && pendingReasoning ? { reasoning: pendingReasoning } : {}),
      });
      pendingReasoning = undefined;
    }
  }
  return result;
}

interface AgentFile {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AgentChatPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const agentId = params.id;

  const [session, setSession] = useState<Session | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<{ usedThisMinute: number; limitPerMinute: number } | null>(null);
  // RT-083 — real RTL/LTR, not just cosmetic text-align: applied to
  // document.documentElement so flex layout (message alignSelf, input row)
  // physically mirrors, not just the text direction within a bubble.
  const [effectiveLanguage, setEffectiveLanguage] = useState('en');
  const t = useLocaleStrings(effectiveLanguage);
  const bottomRef = useRef<HTMLDivElement>(null);
  // RT-084 — reasoning traces are collapsed by default (can be long/noisy);
  // tracked per message index since messages re-render on every token.
  const [expandedReasoning, setExpandedReasoning] = useState<Set<number>>(new Set());
  function toggleReasoning(index: number) {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // RT-025 — files attached to this agent's own workspace. RT-021 makes this
  // panel a persistent part of the 3-panel layout, not a toggle.
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  // RT-022 — session management: an agent can have many conversations.
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // RT-021 — Control panel: switch agent + (admin) create a new one, per
  // docs/spect/00_VISION/05-ux-ui-design.md §5.1's reference layout.
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentRoleChoice, setNewAgentRoleChoice] = useState<string>(AGENT_ROLE_CATALOG[0]?.value ?? '__other__');
  const [newAgentCustomRole, setNewAgentCustomRole] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [createAgentError, setCreateAgentError] = useState<string | null>(null);

  function loadSessions() {
    api
      .listConversations(agentId)
      .then(setSessions)
      .catch((err) => setSessionsError(err instanceof ApiError ? err.message : 'Failed to load sessions'));
  }

  async function handleNewSession() {
    try {
      const conversation = await api.createConversation(agentId);
      setConversationId(conversation.id);
      setMessages([]);
      setNotice(null);
      loadSessions();
    } catch (err) {
      setSessionsError(err instanceof ApiError ? err.message : 'Failed to create a new session');
    }
  }

  async function handleSwitchSession(id: string) {
    if (id === conversationId) return;
    try {
      const { messages: history } = await api.getConversationMessages(agentId, id);
      setMessages(toDisplayMessages(history));
      setConversationId(id);
      setNotice(null);
    } catch (err) {
      setSessionsError(err instanceof ApiError ? err.message : 'Failed to load that session');
    }
  }

  async function handleRenameSession(id: string, currentTitle: string | null) {
    const title = window.prompt('Rename session', currentTitle ?? '');
    if (!title || !title.trim()) return;
    try {
      await api.renameConversation(agentId, id, title.trim());
      loadSessions();
    } catch (err) {
      setSessionsError(err instanceof ApiError ? err.message : 'Failed to rename session');
    }
  }

  async function handleArchiveSession(id: string) {
    if (!window.confirm('Archive this session? It will no longer appear in the recent list.')) return;
    try {
      await api.archiveConversation(agentId, id);
      loadSessions();
      // The active session was archived out from under the user — fall back
      // to whatever the server now considers "latest" instead of leaving the
      // chat pointed at a session that no longer appears anywhere in the UI.
      if (id === conversationId) {
        setConversationId(undefined);
        setMessages([]);
        loadHistory().catch(() => {});
      }
    } catch (err) {
      setSessionsError(err instanceof ApiError ? err.message : 'Failed to archive session');
    }
  }

  async function handleCreateAgent(e: FormEvent) {
    e.preventDefault();
    const role = newAgentRoleChoice === '__other__' ? newAgentCustomRole : newAgentRoleChoice;
    setCreatingAgent(true);
    setCreateAgentError(null);
    try {
      // RT-023 — a dedicated 1:1 workspace per agent, same as the /agents page.
      const dedicatedWorkspace = await api.createWorkspace({ name: `${newAgentName} Workspace` });
      const created = await api.createAgent({ name: newAgentName, role, workspaceId: dedicatedWorkspace.id });
      setShowCreateAgent(false);
      setNewAgentName('');
      setNewAgentCustomRole('');
      router.push(`/agents/${created.id}/chat`);
    } catch (err) {
      setCreateAgentError(err instanceof ApiError ? err.message : 'Failed to create agent');
    } finally {
      setCreatingAgent(false);
    }
  }

  function loadFiles() {
    api
      .listAgentFiles(agentId)
      .then(setFiles)
      .catch((err) => setFilesError(err instanceof ApiError ? err.message : 'Failed to load files'));
  }

  async function handleUploadFile(file: File | undefined) {
    if (!file) return;
    setUploadingFile(true);
    setFilesError(null);
    try {
      await api.uploadAgentFile(agentId, file);
      loadFiles();
    } catch (err) {
      setFilesError(err instanceof ApiError ? err.message : 'Failed to upload file');
    } finally {
      setUploadingFile(false);
    }
  }

  async function handleDownloadFile(fileId: string) {
    try {
      const { url } = await api.getAgentFileDownloadUrl(agentId, fileId);
      window.open(url, '_blank');
    } catch (err) {
      setFilesError(err instanceof ApiError ? err.message : 'Failed to get download link');
    }
  }

  async function handleDeleteFile(fileId: string) {
    if (!window.confirm('Delete this file?')) return;
    try {
      await api.deleteAgentFile(agentId, fileId);
      loadFiles();
    } catch (err) {
      setFilesError(err instanceof ApiError ? err.message : 'Failed to delete file');
    }
  }

  function loadRateLimit() {
    api
      .getRateLimitStatus(agentId)
      .then(setRateLimit)
      .catch(() => {}); // non-fatal, purely informational
  }

  /** Authoritative reload from the server — used both on page mount and after a dropped connection. */
  async function loadHistory(): Promise<number> {
    const { conversation, messages: history } = await api.getLatestConversation(agentId);
    if (!conversation) return 0;
    setConversationId(conversation.id);
    const displayable = toDisplayMessages(history);
    setMessages(displayable);
    return displayable.length;
  }

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    api
      .getAgent(agentId)
      .then(setAgent)
      .catch((err) => setNotice(err instanceof ApiError ? err.message : 'Failed to load agent'));

    // Resume the most recent conversation instead of starting empty every time the page loads.
    loadHistory().catch((err) =>
      setNotice(err instanceof ApiError ? err.message : 'Failed to load conversation history'),
    );
    loadRateLimit();
    loadSessions();
    loadFiles();
    api
      .listAgents()
      .then(setAgents)
      .catch(() => {}); // Control panel's agent switcher — non-fatal if it fails to load

    // RT-083 — effective language is user.language ?? organization.language;
    // fetched fresh (not cached on session) since either can change without
    // a re-login (settings page, or the check-in scheduler for the org).
    Promise.all([api.getOrganization(), api.getMe()])
      .then(([org, me]) => {
        const lang = me.language ?? org.language;
        setEffectiveLanguage(lang);
        applyDocumentDirection(lang);
      })
      .catch(() => {});
  }, [agentId, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const userMessage = input;
    const countBeforeSend = messages.length;
    setInput('');
    setNotice(null);
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setMessages((prev) => [...prev, { role: 'agent', content: '', pending: true }]);
    setSending(true);

    try {
      await streamChat(agentId, userMessage, conversationId, {
        onToken: (delta) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'agent') last.content += delta;
            return next;
          });
        },
        onReasoningToken: (delta) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'agent') last.reasoning = (last.reasoning ?? '') + delta;
            return next;
          });
        },
        onDone: ({ conversationId: newConversationId }) => {
          setConversationId(newConversationId);
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) last.pending = false;
            return next;
          });
          setSending(false);
          loadRateLimit();
        },
        onRequiresApproval: () => {
          setMessages((prev) => prev.slice(0, -1)); // drop the pending placeholder
          setNotice('This request exceeds the cost threshold and is waiting for approval.');
          setSending(false);
        },
        onError: (message) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) {
              last.content = `Error: ${message}`;
              last.pending = false;
            }
            return next;
          });
          setSending(false);
        },
        onDisconnect: () => {
          // Don't guess whether the message landed — the LLM call may have
          // already completed and been persisted server-side even though
          // delivery to the browser was cut. Reload from server truth
          // instead of blindly resending (which risks a duplicate response
          // and double-charging a paid provider).
          setNotice('Connection lost — checking whether your message went through…');
          loadHistory()
            .then((countAfter) => {
              setNotice(
                countAfter > countBeforeSend + 1
                  ? 'Reconnected — your message did go through.'
                  : 'Connection was lost and the message may not have been delivered. Please try sending it again.',
              );
            })
            .catch(() => setNotice('Connection lost and could not reconnect. Please refresh the page.'))
            .finally(() => setSending(false));
        },
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to send message');
      setSending(false);
    }
  }

  return (
    <div dir={isRtlLanguage(effectiveLanguage) ? 'rtl' : 'ltr'}>
      {session ? <Sidebar session={session} /> : null}

      <div className="topbar">
        <Link href="/agents">
          {isRtlLanguage(effectiveLanguage)
            ? `${t('chat.backToAgents', 'Agents')} →`
            : `← ${t('chat.backToAgents', 'Agents')}`}
        </Link>
        <nav>
          <strong>{agent?.name ?? 'Loading…'}</strong>
          {rateLimit ? (
            <span
              style={{
                fontSize: 12,
                color: rateLimit.usedThisMinute >= rateLimit.limitPerMinute ? 'var(--color-error)' : 'var(--color-muted-foreground)',
              }}
              title="Requests this minute"
            >
              {rateLimit.usedThisMinute}/{rateLimit.limitPerMinute} req/min
            </span>
          ) : null}
        </nav>
      </div>

      {/* RT-021 — 3-panel layout (Control/Chat/Workspace), mirrored under RTL
          so Control ends up on the reading-start side either way. */}
      <div
        className="page"
        style={{
          display: 'flex',
          flexDirection: isRtlLanguage(effectiveLanguage) ? 'row-reverse' : 'row',
          gap: 16,
          height: 'calc(100vh - 120px)',
        }}
      >
        <div className="card" style={{ width: 240, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={agentId}
              onChange={(e) => router.push(`/agents/${e.target.value}/chat`)}
              style={{ flex: 1 }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {session?.role === 'admin' ? (
              <button
                className="secondary"
                title="New agent"
                onClick={() => setShowCreateAgent((v) => !v)}
              >
                +
              </button>
            ) : null}
          </div>

          {showCreateAgent ? (
            <form onSubmit={handleCreateAgent} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--color-border)', paddingBottom: 10 }}>
              {createAgentError ? <div className="error">{createAgentError}</div> : null}
              <input
                placeholder="Agent name"
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                required
              />
              <select value={newAgentRoleChoice} onChange={(e) => setNewAgentRoleChoice(e.target.value)}>
                {AGENT_ROLE_CATALOG.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
                <option value="__other__">Other…</option>
              </select>
              {newAgentRoleChoice === '__other__' ? (
                <input
                  placeholder="Custom role"
                  value={newAgentCustomRole}
                  onChange={(e) => setNewAgentCustomRole(e.target.value)}
                  required
                />
              ) : null}
              <button type="submit" disabled={creatingAgent}>
                {creatingAgent ? 'Creating…' : 'Create agent'}
              </button>
            </form>
          ) : null}

          <button onClick={handleNewSession}>+ New session</button>

          <strong style={{ fontSize: 13 }}>Recent sessions</strong>
          {sessionsError ? <div className="error">{sessionsError}</div> : null}
          {sessions.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>No sessions yet.</p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                style={{
                  borderTop: '1px solid var(--color-border)',
                  paddingTop: 8,
                  fontSize: 12,
                  background: s.id === conversationId ? 'var(--color-primary-subtle)' : undefined,
                }}
              >
                <button
                  className="secondary"
                  style={{ width: '100%', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={s.title ?? s.id}
                  onClick={() => handleSwitchSession(s.id)}
                >
                  {s.title ?? `Session ${s.id.slice(0, 8)}`}
                </button>
                <div className="muted" style={{ fontSize: 11, marginTop: 2, marginBottom: 4 }}>
                  {s.messageCount} messages
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="secondary" onClick={() => handleRenameSession(s.id, s.title)}>
                    Rename
                  </button>
                  <button className="secondary" onClick={() => handleArchiveSession(s.id)}>
                    Archive
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {notice ? <div className="error">{notice}</div> : null}

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 ? (
              <p style={{ color: 'var(--color-muted-foreground)' }}>Say hello to {agent?.name ?? 'your agent'} to start the conversation.</p>
            ) : null}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                {m.reasoning ? (
                  // RT-084 — rendered as its own, visually distinct block
                  // ABOVE the agent's bubble (not merged into it), matching
                  // the "مستقل از پیام‌های عادی" requirement.
                  <div
                    className="card"
                    style={{
                      marginBottom: 6,
                      fontSize: 12,
                      fontStyle: 'italic',
                      color: 'var(--color-muted-foreground)',
                      background: 'transparent',
                      border: '1px dashed var(--color-border)',
                    }}
                  >
                    <button
                      className="secondary"
                      style={{ fontSize: 11, marginBottom: expandedReasoning.has(i) ? 6 : 0 }}
                      onClick={() => toggleReasoning(i)}
                    >
                      {expandedReasoning.has(i) ? '🧠 Hide reasoning' : '🧠 Show reasoning'}
                    </button>
                    {expandedReasoning.has(i) ? <div>{m.reasoning}</div> : null}
                  </div>
                ) : null}
                <div
                  className="card"
                  style={{ background: m.role === 'user' ? 'var(--color-primary-subtle)' : 'var(--color-surface)' }}
                >
                  {m.content || (m.pending ? '…' : '')}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={handleSend} style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('chat.inputPlaceholder', 'Type a message…')}
              style={{ flex: 1 }}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !input.trim()}>
              {t('chat.send', 'Send')}
            </button>
          </form>
        </div>

        <div className="card" style={{ width: 280, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 13 }}>Workspace files</strong>
            <button className="secondary" onClick={loadFiles} title="Refresh">
              ↻
            </button>
          </div>
          {filesError ? <div className="error">{filesError}</div> : null}
            {files.length === 0 ? (
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>No files yet.</p>
            ) : (
              files.map((f) => (
                <div key={f.id} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 8, fontSize: 12 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.filename}>
                    {f.filename}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{formatFileSize(f.sizeBytes)}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="secondary" onClick={() => handleDownloadFile(f.id)}>
                      Open
                    </button>
                    <button className="secondary" onClick={() => handleDeleteFile(f.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
            <input
              type="file"
              disabled={uploadingFile}
              onChange={(e) => handleUploadFile(e.target.files?.[0])}
              style={{ marginTop: 8 }}
            />
            {uploadingFile ? <span className="muted" style={{ fontSize: 12 }}>Uploading…</span> : null}
        </div>
      </div>
    </div>
  );
}
