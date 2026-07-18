'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent, Conversation } from '@o2n/shared';
import { api, loadSession, streamChat, ApiError, type Session } from '@/lib/api-client';
import { applyDocumentDirection, isRtlLanguage } from '@/lib/i18n';
import { Sidebar } from '@/components/Sidebar';

interface DisplayMessage {
  role: 'user' | 'agent';
  content: string;
  pending?: boolean;
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
  const bottomRef = useRef<HTMLDivElement>(null);

  // RT-025 — files attached to this agent's own workspace.
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  // RT-022 — session management: an agent can have many conversations.
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

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
      const displayable = history.filter((m) => m.role === 'user' || m.role === 'agent');
      setMessages(displayable.map((m) => ({ role: m.role as 'user' | 'agent', content: m.content })));
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
    const displayable = history.filter((m) => m.role === 'user' || m.role === 'agent');
    setMessages(displayable.map((m) => ({ role: m.role as 'user' | 'agent', content: m.content })));
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
        <Link href="/agents">{isRtlLanguage(effectiveLanguage) ? 'Agents →' : '← Agents'}</Link>
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
          <button
            className="secondary"
            onClick={() => {
              setShowSessions((v) => !v);
              if (!showSessions) loadSessions();
            }}
          >
            {showSessions ? 'Hide sessions' : 'Sessions'}
          </button>
          <button className="secondary" onClick={handleNewSession}>
            + New session
          </button>
          <button
            className="secondary"
            onClick={() => {
              setShowFiles((v) => !v);
              if (!showFiles) loadFiles();
            }}
          >
            {showFiles ? 'Hide files' : 'Files'}
          </button>
        </nav>
      </div>

      <div className="page" style={{ display: 'flex', gap: 16, height: 'calc(100vh - 120px)' }}>
        {showSessions ? (
          <div className="card" style={{ width: 240, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        ) : null}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {notice ? <div className="error">{notice}</div> : null}

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 ? (
              <p style={{ color: 'var(--color-muted-foreground)' }}>Say hello to {agent?.name ?? 'your agent'} to start the conversation.</p>
            ) : null}
            {messages.map((m, i) => (
              <div
                key={i}
                className="card"
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '75%',
                  background: m.role === 'user' ? 'var(--color-primary-subtle)' : 'var(--color-surface)',
                }}
              >
                {m.content || (m.pending ? '…' : '')}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={handleSend} style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              style={{ flex: 1 }}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !input.trim()}>
              Send
            </button>
          </form>
        </div>

        {showFiles ? (
          <div className="card" style={{ width: 280, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <strong style={{ fontSize: 13 }}>Workspace files</strong>
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
                      Download
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
        ) : null}
      </div>
    </div>
  );
}
