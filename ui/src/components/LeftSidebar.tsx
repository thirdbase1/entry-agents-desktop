import React, { useState } from 'react';
import type { ConversationItem, UserAccount } from '../types';

interface LeftSidebarProps {
  conversations: ConversationItem[];
  activeId: string;
  onSelectConv: (id: string) => void;
  onNewConv: () => void;
  onToggleLeft: () => void;
  onOpenAutomations: () => void;
  onOpenCustomizations: () => void;
  onOpenSettings: () => void;
  activeProject?: string;
  onSelectProjectDir?: () => void;
  account: UserAccount | null;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  conversations,
  activeId,
  onSelectConv,
  onNewConv,
  onToggleLeft,
  onOpenAutomations,
  onOpenCustomizations,
  onOpenSettings,
  activeProject,
  onSelectProjectDir,
  account,
}) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredConvs = searchQuery.trim()
    ? conversations.filter(c => c.t.toLowerCase().includes(searchQuery.toLowerCase()))
    : conversations;

  return (
    <aside className="left" aria-label="Navigation">
      <div className="left-inner">
        {/* Navigation Bar */}
        <div className="bar">
          <span className="logo" title="Entry">
            <svg className="i"><use href="#i-logo" /></svg>
          </span>
          <button className="ibtn" id="btnLeft" aria-label="Hide sidebar" title="Hide sidebar" onClick={onToggleLeft}>
            <svg className="i"><use href="#i-sidebar" /></svg>
          </button>
          <button className="ibtn" disabled aria-label="Back">
            <svg className="i"><use href="#i-back" /></svg>
          </button>
          <button className="ibtn" disabled aria-label="Forward">
            <svg className="i"><use href="#i-forward" /></svg>
          </button>
          <button
            className="ibtn"
            id="btnSearch"
            aria-label="Search conversations"
            title="Search conversations"
            onClick={() => setSearchOpen(prev => !prev)}
          >
            <svg className="i"><use href="#i-search" /></svg>
          </button>
        </div>

        {/* New Conversation Button */}
        <button className="new" id="btnNew" onClick={onNewConv}>
          <svg className="i"><use href="#i-plus" /></svg>New Conversation
        </button>

        {/* Navigation Links */}
        <nav className="nav">
          <button id="navHistory" onClick={() => setSearchOpen(true)}>
            <svg className="i"><use href="#i-history" /></svg>Conversation History
          </button>
          <button onClick={onOpenAutomations}>
            <svg className="i"><use href="#i-bolt" /></svg>Automations
          </button>
          <button onClick={onOpenCustomizations}>
            <svg className="i"><use href="#i-case" /></svg>Customizations
          </button>
        </nav>

        {/* Projects Section */}
        <div className="sec">
          <span>Projects</span>
          <span>
            <button className="ibtn" aria-label="Filter projects" title="Filter projects">
              <svg className="i"><use href="#i-filter" /></svg>
            </button>
            <button className="ibtn" aria-label="Open project workspace" title="Open project workspace" onClick={onSelectProjectDir}>
              <svg className="i"><use href="#i-folder" /></svg>
            </button>
          </span>
        </div>
        {activeProject ? (
          <div className="none" style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: '12px' }} title={activeProject}>
            {activeProject.split(/[\\/]/).pop() || activeProject}
          </div>
        ) : (
          <div className="none">No projects yet</div>
        )}

        {/* Conversations Section */}
        <div className="sec">
          <span>Conversations</span>
          <button className="ibtn" id="btnNew2" aria-label="New conversation" onClick={onNewConv}>
            <svg className="i"><use href="#i-plus" /></svg>
          </button>
        </div>

        {/* Search Input Filter */}
        <div className={`search ${searchOpen ? 'on' : ''}`} id="searchWrap">
          <input
            id="searchInput"
            type="search"
            placeholder="Filter conversations"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            aria-label="Filter conversations"
            autoFocus={searchOpen}
          />
        </div>

        {/* Conversations List */}
        <div className="convs" id="convs">
          {filteredConvs.map(c => (
            <button
              key={c.id}
              className={`conv ${c.id === activeId ? 'active' : ''}`}
              onClick={() => onSelectConv(c.id)}
            >
              <span className="t">{c.t}</span>
              {c.dot ? (
                <span className="dot" aria-label="Unread" />
              ) : (
                <span className="m">{c.time || ''}</span>
              )}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="foot">
          <button onClick={onOpenSettings}>
            <svg className="i"><use href="#i-gear" /></svg>Settings
          </button>
          {account ? (
            <span className="auth-badge signed-in" title={account.email || account.name || 'Signed In'}>
              {account.plan ? account.plan.toUpperCase() : 'PRO'}
            </span>
          ) : (
            <span className="auth-badge">Local</span>
          )}
        </div>
      </div>
    </aside>
  );
};
