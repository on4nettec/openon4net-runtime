'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent } from '@o2n/shared';
import { api, loadSession, streamChat, ApiError } from '@/lib/api-client';

interface DisplayMessage {
  role: 'user' | 'agent';
  content: string;
  pending?: boolean;
}

export default function AgentChatPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const agentId = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<{ usedThisMinute: number; limitPerMinute: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    if (!loadSession()) {
      router.push('/login');
      return;
    }
    api
      .getAgent(agentId)
      .then(setAgent)
      .catch((err) => setNotice(err instanceof ApiError ? err.message : 'Failed to load agent'));

    // Resume the most recent conversation instead of starting empty every time the page loads.
    loadHistory().catch((err) =>
      setNotice(err instanceof ApiError ? err.message : 'Failed to load conversation history'),
    );
    loadRateLimit();
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
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <strong>{agent?.name ?? 'Loading…'}</strong>
          {rateLimit ? (
            <span
              style={{
                fontSize: 12,
                color: rateLimit.usedThisMinute >= rateLimit.limitPerMinute ? '#f2555a' : '#9aa0aa',
              }}
              title="Requests this minute"
            >
              {rateLimit.usedThisMinute}/{rateLimit.limitPerMinute} req/min
            </span>
          ) : null}
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
        {notice ? <div className="error">{notice}</div> : null}

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.length === 0 ? (
            <p style={{ color: '#9aa0aa' }}>Say hello to {agent?.name ?? 'your agent'} to start the conversation.</p>
          ) : null}
          {messages.map((m, i) => (
            <div
              key={i}
              className="card"
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '75%',
                background: m.role === 'user' ? '#22406b' : '#171a20',
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
    </div>
  );
}
