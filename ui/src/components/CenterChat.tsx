import React, { useState, useRef, useEffect } from 'react';
import type { ConversationItem, LiveModelOption, ToolExecution } from '../types';

interface CenterChatProps {
  conversation: ConversationItem;
  models: LiveModelOption[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  turbo: boolean;
  onToggleTurbo: () => void;
  onSendMessage: (text: string) => void;
  isGenerating: boolean;
  onStopGenerating: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  leftHidden: boolean;
  rightHidden: boolean;
}

export const CenterChat: React.FC<CenterChatProps> = ({
  conversation,
  models,
  selectedModel,
  onSelectModel,
  turbo,
  onToggleTurbo,
  onSendMessage,
  isGenerating,
  onStopGenerating,
  onToggleLeft,
  onToggleRight,
  leftHidden,
  rightHidden,
}) => {
  const [inputText, setInputText] = useState('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeModelObj = models.find(m => m.id === selectedModel) || {
    id: selectedModel,
    name: selectedModel || 'Gemini 3.8 Flash High',
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || isGenerating) return;
    onSendMessage(text);
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const checkScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(distFromBottom > 80);
  };

  const scrollToBottom = () => {
    const el = threadRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversation.messages]);

  return (
    <main className="center">
      {/* Center Header */}
      <div className="bar center-head">
        {leftHidden && (
          <button className="ibtn" id="openLeft" aria-label="Show sidebar" onClick={onToggleLeft}>
            <svg className="i"><use href="#i-sidebar" /></svg>
          </button>
        )}
        <h1 id="convTitle">{conversation.t}</h1>
        <button className="ibtn" aria-label="More options" title="More options">
          <svg className="i"><use href="#i-kebab" /></svg>
        </button>
        {rightHidden && (
          <button className="ibtn" id="openRight" aria-label="Show artifact panel" onClick={onToggleRight}>
            <svg className="i"><use href="#i-panel" /></svg>
          </button>
        )}
      </div>

      {/* Message Thread Area */}
      <div className="thread-wrap">
        <div className="thread" id="thread" ref={threadRef} onScroll={checkScroll}>
          <div className="thread-inner" id="threadInner">
            {/* Sticky Prompt Wrap */}
            {conversation.prompt && (
              <div className="prompt-wrap">
                <div className="prompt">{conversation.prompt}</div>
              </div>
            )}

            {conversation.messages.length === 0 ? (
              <div className="empty">
                <p>New conversation</p>
                <span>Describe what you want the agent to build or fix.</span>
              </div>
            ) : (
              conversation.messages.map(msg => (
                <div key={msg.id}>
                  {msg.role === 'user' ? (
                    <div className="user-msg">{msg.content}</div>
                  ) : (
                    <div className="msg">
                      {/* Tool Executions */}
                      {msg.tools && msg.tools.map(tool => (
                        <ToolCard key={tool.id} tool={tool} />
                      ))}
                      {/* Render text with basic markdown formatting */}
                      <RenderMessageContent content={msg.content} />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Floating Jump to Bottom Button */}
        {showJump && (
          <button className="jump" id="jump" aria-label="Scroll to latest" onClick={scrollToBottom}>
            <svg className="i"><use href="#i-down" /></svg>
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="composer">
        <div className="box">
          <textarea
            ref={textareaRef}
            id="input"
            rows={1}
            placeholder="Ask the agent anything"
            aria-label="Message"
            value={inputText}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
          />
          <div className="tools">
            <button className="ibtn" aria-label="Attach" title="Attach file">
              <svg className="i"><use href="#i-plus" /></svg>
            </button>
            {/* Model Selector Chip */}
            <button
              className="chip"
              id="modelBtn"
              aria-haspopup="true"
              aria-expanded={modelMenuOpen}
              onClick={() => setModelMenuOpen(prev => !prev)}
            >
              <span id="modelLabel">{activeModelObj.name}</span>
              <svg className="i"><use href="#i-chev" /></svg>
            </button>

            {modelMenuOpen && (
              <div className="menu" id="modelMenu" role="menu">
                {models.map(m => (
                  <button
                    key={m.id}
                    role="menuitemradio"
                    aria-checked={m.id === selectedModel}
                    onClick={() => {
                      onSelectModel(m.id);
                      setModelMenuOpen(false);
                    }}
                  >
                    <span>{m.name}</span>
                    {m.id === selectedModel && <svg className="i" style={{ width: 14, height: 14 }}><use href="#i-check" /></svg>}
                  </button>
                ))}
              </div>
            )}

            <span className="sp" />

            {/* Turbo Toggle */}
            <button
              className="chip"
              id="turbo"
              aria-pressed={turbo}
              onClick={onToggleTurbo}
              title="Turbo execution mode"
            >
              <svg className="i"><use href="#i-clock" /></svg>Turbo
            </button>

            {/* Dictate Button */}
            <button className="ibtn" aria-label="Dictate" title="Voice dictation">
              <svg className="i"><use href="#i-mic" /></svg>
            </button>

            {/* Send / Stop Button */}
            {isGenerating ? (
              <button className="send stop" aria-label="Stop generation" onClick={onStopGenerating} title="Stop generation">
                <svg className="i" style={{ width: 14, height: 14 }} viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" fill="currentColor" /></svg>
              </button>
            ) : (
              <button className="send" id="send" aria-label="Send" onClick={handleSend} title="Send message">
                <svg className="i"><use href="#i-forward" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
};

const ToolCard: React.FC<{ tool: ToolExecution }> = ({ tool }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => setOpen(prev => !prev)}>
        <span className="tool-title">
          <svg className="i" style={{ width: 14, height: 14 }}><use href="#i-bolt" /></svg>
          {tool.name}
        </span>
        <span className={`tool-badge ${tool.status}`}>
          {tool.status === 'running' && 'Running...'}
          {tool.status === 'success' && 'Done'}
          {tool.status === 'error' && 'Failed'}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <div style={{ marginBottom: 6, color: 'var(--text-3)' }}>
              args: {JSON.stringify(tool.args, null, 2)}
            </div>
          )}
          {tool.output && <div>{tool.output}</div>}
        </div>
      )}
    </div>
  );
};

const RenderMessageContent: React.FC<{ content: string }> = ({ content }) => {
  // Simple markdown renderer for headers, bold, bullet points, and code
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inList = false;
  let listItems: React.ReactNode[] = [];

  const flushList = () => {
    if (inList && listItems.length > 0) {
      elements.push(<ul key={`ul-${elements.length}`}>{listItems}</ul>);
      listItems = [];
      inList = false;
    }
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      flushList();
      elements.push(<h2 key={idx}>{trimmed.slice(3)}</h2>);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      inList = true;
      listItems.push(<li key={idx}>{formatInline(trimmed.slice(2))}</li>);
    } else if (/^\d+\.\s/.test(trimmed)) {
      flushList();
      const match = trimmed.match(/^\d+\.\s(.*)$/);
      elements.push(<div key={idx} style={{ margin: '6px 0' }}>{formatInline(match ? match[1] : trimmed)}</div>);
    } else if (trimmed === '') {
      flushList();
    } else {
      flushList();
      elements.push(<p key={idx} style={{ margin: '6px 0' }}>{formatInline(trimmed)}</p>);
    }
  });

  flushList();
  return <>{elements}</>;
};

function formatInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`)|(\*[^*]+\*)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}
