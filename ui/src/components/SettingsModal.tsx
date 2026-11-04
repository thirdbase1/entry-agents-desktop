import React from 'react';
import type { UserAccount } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  account: UserAccount | null;
  onSignInBrowser: () => void;
  onSignOut: () => void;
  activeProjectDir?: string;
  onPickProjectDir?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  account,
  onSignInBrowser,
  onSignOut,
  activeProjectDir,
  onPickProjectDir,
}) => {
  if (!isOpen) return null;

  return (
    <div className="scrim on" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <svg className="i" style={{ color: 'var(--accent)' }}><use href="#i-gear" /></svg>
            Entry Settings
          </h2>
          <button className="ibtn" onClick={onClose} aria-label="Close">
            <svg className="i"><use href="#i-close" /></svg>
          </button>
        </div>

        <div className="modal-body">
          {/* Account Section */}
          <div style={{ marginBottom: 24, paddingBottom: 18, borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>Account & Authentication</div>
            {account ? (
              <div style={{ background: '#202024', padding: '14px 16px', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--line)' }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#fff', fontSize: '14.5px' }}>{account.name || account.email || 'Entry User'}</div>
                  <div style={{ color: 'var(--text-3)', fontSize: '13px' }}>{account.email || 'Connected to entry-agents.dev'}</div>
                  <div style={{ marginTop: 6, display: 'inline-block', fontSize: '11px', background: 'rgba(48,209,88,0.15)', color: '#30d158', padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>
                    {account.plan ? account.plan.toUpperCase() : 'ACTIVE'}
                  </div>
                </div>
                <button className="btn-secondary" onClick={onSignOut}>Sign Out</button>
              </div>
            ) : (
              <div style={{ background: '#202024', padding: '16px', borderRadius: 8, textAlign: 'center', border: '1px solid var(--line)' }}>
                <p style={{ margin: '0 0 14px', color: 'var(--text-2)', fontSize: '13.5px' }}>
                  Connect your Entry account to access cloud models and workspace sync.
                </p>
                <button className="btn-primary" onClick={onSignInBrowser} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <svg className="i" style={{ width: 16, height: 16 }}><use href="#i-logo" /></svg>
                  Sign in with Entry
                </button>
              </div>
            )}
          </div>

          {/* Backend Gateway */}
          <div style={{ marginBottom: 24, paddingBottom: 18, borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Backend Gateway</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="text"
                value="https://entry-agents.dev"
                readOnly
                style={{ flex: 1, background: '#18181a', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px', color: '#fff', fontFamily: 'var(--mono)', fontSize: '13px' }}
              />
              <span style={{ fontSize: '11px', color: '#30d158', background: 'rgba(48,209,88,0.15)', padding: '4px 8px', borderRadius: 4 }}>Verified</span>
            </div>
          </div>

          {/* Active Workspace */}
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Project Workspace</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="text"
                value={activeProjectDir || 'No workspace opened'}
                readOnly
                style={{ flex: 1, background: '#18181a', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px', color: '#fff', fontFamily: 'var(--mono)', fontSize: '13px' }}
              />
              <button className="btn-secondary" onClick={onPickProjectDir}>Browse</button>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
