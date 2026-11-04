import React, { useState } from 'react';
import type { AutomationItem } from '../types';

interface AutomationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  automations: AutomationItem[];
  onToggleAutomation: (id: string) => void;
  onRunNow: (id: string) => void;
  onCreateAutomation: (name: string, schedule: string, prompt: string) => void;
}

export const AutomationsModal: React.FC<AutomationsModalProps> = ({
  isOpen,
  onClose,
  automations,
  onToggleAutomation,
  onRunNow,
  onCreateAutomation,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');

  if (!isOpen) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    onCreateAutomation(name.trim(), schedule.trim(), prompt.trim());
    setName('');
    setPrompt('');
    setIsAdding(false);
  };

  return (
    <div className="scrim on" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <svg className="i" style={{ color: 'var(--accent)' }}><use href="#i-bolt" /></svg>
            Automations & Scheduled Routines
          </h2>
          <button className="ibtn" onClick={onClose} aria-label="Close">
            <svg className="i"><use href="#i-close" /></svg>
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ color: 'var(--text-3)', fontSize: '13.5px' }}>
              Recurring routines executed locally via the background agent sidecar.
            </span>
            <button className="btn-primary" onClick={() => setIsAdding(prev => !prev)}>
              {isAdding ? 'Cancel' : '+ New Automation'}
            </button>
          </div>

          {isAdding && (
            <form onSubmit={handleCreate} style={{ background: '#202022', padding: 14, borderRadius: 8, marginBottom: 18, border: '1px solid var(--line-strong)' }}>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-2)', marginBottom: 4 }}>Name</label>
                <input
                  type="text"
                  placeholder="e.g. Morning Code Review"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  style={{ width: '100%', background: '#18181a', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px', color: '#fff', font: 'inherit' }}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-2)', marginBottom: 4 }}>Schedule (Cron Expression)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={schedule}
                    onChange={e => setSchedule(e.target.value)}
                    style={{ flex: 1, background: '#18181a', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px', color: '#fff', fontFamily: 'var(--mono)' }}
                  />
                  <button type="button" className="btn-secondary" onClick={() => setSchedule('*/30 * * * *')}>Every 30m</button>
                  <button type="button" className="btn-secondary" onClick={() => setSchedule('0 * * * *')}>Hourly</button>
                  <button type="button" className="btn-secondary" onClick={() => setSchedule('0 9 * * *')}>Daily 9am</button>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-2)', marginBottom: 4 }}>Agent Prompt / Task</label>
                <textarea
                  rows={3}
                  placeholder="e.g. Scan changed files, run tests, and summarize unresolved bugs"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  style={{ width: '100%', background: '#18181a', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px', color: '#fff', font: 'inherit', resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="submit" className="btn-primary">Save Automation</button>
              </div>
            </form>
          )}

          {automations.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--text-3)' }}>
              No scheduled automations configured yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {automations.map(auto => (
                <div
                  key={auto.id}
                  style={{
                    background: '#202023',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, paddingRight: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text)', fontSize: '14.5px' }}>{auto.name}</strong>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', background: '#2c2c30', color: 'var(--accent)', padding: '2px 6px', borderRadius: 4 }}>
                        {auto.schedule}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-2)', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {auto.prompt}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: '12px', padding: '5px 10px' }}
                      onClick={() => onRunNow(auto.id)}
                      title="Run immediately"
                    >
                      <svg className="i" style={{ width: 12, height: 12, marginRight: 4 }}><use href="#i-play" /></svg>
                      Run Now
                    </button>
                    <button
                      className="ibtn"
                      style={{ color: auto.enabled ? '#30d158' : 'var(--text-3)' }}
                      onClick={() => onToggleAutomation(auto.id)}
                      title={auto.enabled ? 'Pause' : 'Enable'}
                    >
                      <svg className="i"><use href={auto.enabled ? '#i-check' : '#i-close'} /></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
