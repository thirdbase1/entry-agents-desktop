import React from 'react';
import type { ArtifactTabItem, DiagramLayer, DiffFile } from '../types';

interface RightPanelProps {
  tabs: ArtifactTabItem[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
  onToggleFull: () => void;
  onToggleRight: () => void;
  isFullRight: boolean;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onToggleFull,
  onToggleRight,
  isFullRight,
}) => {
  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <aside className="right" aria-label="Artifact panel">
      <div className="right-inner">
        {/* Tab Bar */}
        <div className="tabs">
          <div className="tab-list" id="tabList" role="tablist">
            {tabs.map(tab => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
              >
                <button
                  className="tab-main"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  onClick={() => onSelectTab(tab.id)}
                >
                  <svg className="i">
                    <use href={tab.isDiff ? '#i-diff' : '#i-file'} />
                  </svg>
                  <span>{tab.title}</span>
                </button>
                <button
                  className="tab-x"
                  aria-label="Close tab"
                  onClick={e => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <svg className="i"><use href="#i-close" /></svg>
                </button>
              </div>
            ))}
          </div>

          <button className="ibtn" id="btnAddTab" aria-label="New tab" title="New tab" onClick={onAddTab}>
            <svg className="i"><use href="#i-plus" /></svg>
          </button>
          <button className="ibtn" id="btnFull" aria-label={isFullRight ? "Restore panel" : "Expand panel"} title={isFullRight ? "Restore panel" : "Expand panel"} onClick={onToggleFull}>
            <svg className="i"><use href="#i-expand" /></svg>
          </button>
          <button className="ibtn" id="btnRight" aria-label="Hide panel" title="Hide panel" onClick={onToggleRight}>
            <svg className="i"><use href="#i-panel" /></svg>
          </button>
        </div>

        {/* Sub-bar */}
        <div className="sub">
          <span>{activeTab?.isDiff ? 'Workspace Diff' : 'Artifact'}</span>
          <span>
            <button className="ibtn" aria-label="Options" title="Options">
              <svg className="i"><use href="#i-kebab" /></svg>
            </button>
            <button className="ibtn" aria-label="Outline" title="Outline">
              <svg className="i"><use href="#i-lines" /></svg>
            </button>
          </span>
        </div>

        {/* Content Area */}
        <div className="doc" id="doc">
          {!activeTab || activeTab.empty ? (
            <div className="doc-empty">
              <p>{activeTab ? 'Nothing here yet' : 'No artifacts open'}</p>
              <span>Documents and diagrams the agent writes appear in this panel.</span>
            </div>
          ) : activeTab.isDiff ? (
            <WorkspaceDiffView files={activeTab.diffFiles || []} />
          ) : activeTab.doc ? (
            <DiagramDocView doc={activeTab.doc} />
          ) : (
            <div className="doc-empty">
              <p>{activeTab.title}</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

const DiagramDocView: React.FC<{ doc: NonNullable<ArtifactTabItem['doc']> }> = ({ doc }) => {
  return (
    <>
      <h1 dangerouslySetInnerHTML={{ __html: doc.h1 }} />
      <p dangerouslySetInnerHTML={{ __html: doc.intro }} />
      <hr className="rule" />
      <h2>1. High-level system architecture</h2>
      <div className="fig">
        <SvgDiagram layers={doc.layers} label={`${doc.title} diagram`} />
      </div>
      <h2>2. How a request flows</h2>
      <ol>
        {doc.flow.map((step, idx) => (
          <li key={idx} dangerouslySetInnerHTML={{ __html: step }} />
        ))}
      </ol>
    </>
  );
};

const SvgDiagram: React.FC<{ layers: DiagramLayer[]; label: string }> = ({ layers, label }) => {
  const W = 520, X = 10, IW = 500, P = 12, G = 8, TH = 24, IH = 38, GAP = 30;
  let currentY = 8;
  const elements: React.ReactNode[] = [];

  layers.forEach((L, i) => {
    const h = TH + IH + P;
    const y = currentY;
    elements.push(
      <rect key={`layer-bg-${i}`} className="dg-layer" x={X} y={y} width={IW} height={h} rx={3} />
    );
    elements.push(
      <text key={`layer-t-${i}`} className="dg-title" x={X + P} y={y + 16}>{L.title}</text>
    );

    const n = L.items.length;
    const w = (IW - 2 * P - (n - 1) * G) / n;

    L.items.forEach((it, k) => {
      const x = X + P + k * (w + G);
      const iy = y + TH;
      elements.push(
        <rect key={`item-bg-${i}-${k}`} className="dg-item" x={x} y={iy} width={w} height={IH} rx={2} />
      );
      elements.push(
        <text key={`item-name-${i}-${k}`} className="dg-name" x={x + w / 2} y={iy + 16} textAnchor="middle">{it[0]}</text>
      );
      elements.push(
        <text key={`item-sub-${i}-${k}`} className="dg-sub" x={x + w / 2} y={iy + 29} textAnchor="middle">{it[1]}</text>
      );
    });

    currentY += h;

    if (i < layers.length - 1) {
      const cx = W / 2;
      const arrowY = currentY;
      elements.push(
        <path
          key={`arrow-${i}`}
          className="dg-arrow"
          d={`M${cx} ${arrowY + 2}V${arrowY + GAP - 4}M${cx - 3.5} ${arrowY + GAP - 9}L${cx} ${arrowY + GAP - 4}L${cx + 3.5} ${arrowY + GAP - 9}`}
        />
      );
      if (L.link) {
        elements.push(
          <text key={`note-${i}`} className="dg-note" x={cx + 9} y={arrowY + GAP / 2 + 3}>{L.link}</text>
        );
      }
      currentY += GAP;
    }
  });

  return (
    <svg viewBox={`0 0 ${W} ${currentY + 8}`} role="img" aria-label={label}>
      {elements}
    </svg>
  );
};

const WorkspaceDiffView: React.FC<{ files: DiffFile[] }> = ({ files }) => {
  if (files.length === 0) {
    return (
      <div className="doc-empty">
        <p>No changes detected</p>
        <span>Active workspace working tree is clean.</span>
      </div>
    );
  }

  return (
    <div className="diff-container">
      {files.map(file => (
        <div key={file.path} className="diff-file-card">
          <div className="diff-header">
            <span>{file.path}</span>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: file.status === 'added' ? '#30d158' : '#0a84ff' }}>
              {file.status}
            </span>
          </div>
          <div className="diff-lines">
            {file.lines.map((line, idx) => (
              <div key={idx} className={`diff-line ${line.type}`}>
                <span className="diff-num">{line.numNew ?? line.numOld ?? ''}</span>
                <span className="diff-content">{line.content}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
