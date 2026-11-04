import React from 'react';


export const ResizerLeft: React.FC<{ onDrag: (newWidth: number) => void }> = ({ onDrag }) => {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--lw'), 10) || 335;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(220, Math.min(520, startWidth + delta));
      onDrag(newWidth);
    };

    const onMouseUp = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return <div className="resizer" id="resizerLeft" onMouseDown={handleMouseDown} />;
};

export const ResizerRight: React.FC<{ onDrag: (newWidth: number) => void }> = ({ onDrag }) => {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rw'), 10) || 560;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(340, Math.min(920, startWidth + delta));
      onDrag(newWidth);
    };

    const onMouseUp = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return <div className="resizer" id="resizerRight" onMouseDown={handleMouseDown} />;
};
