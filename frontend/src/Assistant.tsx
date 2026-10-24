import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { usePortal } from './api.tsx';

type Msg = { role: 'user' | 'assistant'; content: string; error?: boolean };

const PROMPTS = {
  distributor: [
    'Brief me: what needs my attention today?',
    'Which retailers will run out before their delivery?',
    'How should I split my cola stock across pending orders?',
  ],
  retailer: ['What should I do about my delayed orders?', 'What do I need to reorder this week?', 'Which supplier is cheapest for chips right now?'],
};

export function Assistant() {
  const { view, role, partyId, ask } = usePortal();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // A new account is a new conversation.
  useEffect(() => setMessages([]), [role, partyId]);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [messages.length, busy]);

  const send = async (content: string) => {
    if (!content.trim() || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: content.trim() }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const res = await ask<{ reply: string }>('/ai/chat', {
        messages: next.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
      });
      setMessages([...next, { role: 'assistant', content: res.reply }]);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: (e as Error).message, error: true }]);
    }
    setBusy(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(text);
  };

  return (
    <>
      <button className="assistant-fab" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '✕' : '✦ Assistant'}
      </button>
      {open && (
        <div className="assistant" role="dialog" aria-label="Assistant">
          <div className="assistant-head">
            <div>
              <b>✦ RecoverRoute assistant</b>
              <div className="muted small">
                {view.ai.enabled ? `Answers from your live data · ${view.ai.model}` : 'AI not configured — add OPENROUTER_API_KEY on the server'}
              </div>
            </div>
            {messages.length > 0 && (
              <button className="btn btn-link" onClick={() => setMessages([])}>
                Clear
              </button>
            )}
          </div>
          <div className="assistant-body">
            {messages.length === 0 && (
              <div className="prompts">
                <p className="muted small">Ask about your orders, stock, delays and suppliers. Try:</p>
                {PROMPTS[role].map((p) => (
                  <button key={p} className="prompt" onClick={() => send(p)} disabled={busy}>
                    {p}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat chat-${m.role} ${m.error ? 'chat-error' : ''}`}>
                {m.content}
              </div>
            ))}
            {busy && <div className="chat chat-assistant muted">Thinking…</div>}
            <div ref={end} />
          </div>
          <form className="thread-form" onSubmit={submit}>
            <input value={text} maxLength={2000} placeholder="Ask anything about your operations…" onChange={(e) => setText(e.target.value)} autoFocus />
            <button className="btn btn-primary" disabled={!text.trim() || busy}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
