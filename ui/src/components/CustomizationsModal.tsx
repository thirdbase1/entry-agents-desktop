import React, { useState } from 'react';
import type { SkillItem, McpServerItem } from '../types';

interface CustomizationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  skills: SkillItem[];
  mcpServers: McpServerItem[];
  onToggleSkill: (id: string) => void;
  onTestMcp: (name: string) => void;
}

export const CustomizationsModal: React.FC<CustomizationsModalProps> = ({
  isOpen,
  onClose,
  skills,
  mcpServers,
  onToggleSkill,
  onTestMcp,
}) => {
  const [activeTab, setActiveTab] = useState<'skills' | 'mcp'>('skills');

  if (!isOpen) return null;

  return (
    <div className="scrim on" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <svg className="i" style={{ color: 'var(--accent)' }}><use href="#i-case" /></svg>
            Customizations
          </h2>
          <button className="ibtn" onClick={onClose} aria-label="Close">
            <svg className="i"><use href="#i-close" /></svg>
          </button>
        </div>

        <div style={{ display: 'flex', gap: 12, padding: '8px 18px', borderBottom: '1px solid var(--line)' }}>
          <button
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: activeTab === 'skills' ? 'var(--bg-active)' : 'none',
              color: activeTab === 'skills' ? 'var(--text)' : 'var(--text-2)',
              fontWeight: 500,
            }}
            onClick={() => setActiveTab('skills')}
          >
            Skills ({skills.length})
          </button>
          <button
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: activeTab === 'mcp' ? 'var(--bg-active)' : 'none',
              color: activeTab === 'mcp' ? 'var(--text)' : 'var(--text-2)',
              fontWeight: 500,
            }}
            onClick={() => setActiveTab('mcp')}
          >
            MCP Servers ({mcpServers.length})
          </button>
        </div>

        <div className="modal-body">
          {activeTab === 'skills' ? (
            <div>
              <div style={{ color: 'var(--text-3)', fontSize: '13px', marginBottom: 14 }}>
                Skills provide specialized workflows and guidelines parsed from SKILL.md files.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {skills.map(s => (
                  <div
                    key={s.id}
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
                        <strong style={{ color: 'var(--text)', fontSize: '14px' }}>{s.name}</strong>
                        <span style={{ fontSize: '10.5px', textTransform: 'uppercase', background: '#2c2c30', color: 'var(--text-2)', padding: '2px 6px', borderRadius: 4 }}>
                          {s.scope}
                        </span>
                      </div>
                      <div style={{ color: 'var(--text-2)', fontSize: '12.5px' }}>{s.description}</div>
                    </div>
                    <button
                      className="ibtn"
                      style={{ color: s.enabled ? '#30d158' : 'var(--text-3)' }}
                      onClick={() => onToggleSkill(s.id)}
                      title={s.enabled ? 'Enabled' : 'Disabled'}
                    >
                      <svg className="i"><use href={s.enabled ? '#i-check' : '#i-close'} /></svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <div style={{ color: 'var(--text-3)', fontSize: '13px', marginBottom: 14 }}>
                Model Context Protocol (MCP) server connections configured in .mcp.json.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {mcpServers.map(mcp => (
                  <div
                    key={mcp.name}
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
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: mcp.status === 'connected' ? '#30d158' : mcp.status === 'error' ? '#ff453a' : '#888' }} />
                        <strong style={{ color: 'var(--text)', fontSize: '14px' }}>{mcp.name}</strong>
                        <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>{mcp.toolsCount} tools</span>
                      </div>
                      <div style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: '11.5px' }}>
                        {mcp.command || mcp.url}
                      </div>
                    </div>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: '12px', padding: '5px 10px' }}
                      onClick={() => onTestMcp(mcp.name)}
                    >
                      <svg className="i" style={{ width: 12, height: 12, marginRight: 4 }}><use href="#i-refresh" /></svg>
                      Test
                    </button>
                  </div>
                ))}
              </div>
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
