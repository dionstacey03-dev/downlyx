import React, { useId, useState } from 'react';

interface TooltipProps {
  content: string;
  children: React.ReactElement<{
    'aria-describedby'?: string;
    onMouseEnter?: React.MouseEventHandler;
    onMouseLeave?: React.MouseEventHandler;
    onFocus?: React.FocusEventHandler;
    onBlur?: React.FocusEventHandler;
  }>;
  placement?: 'top' | 'bottom';
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = 'top',
  className = '',
}) => {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();

  const positionClass =
    placement === 'bottom'
      ? 'top-full mt-2 left-1/2 -translate-x-1/2'
      : 'bottom-full mb-2 left-1/2 -translate-x-1/2';

  return (
    <span className={`relative inline-flex ${className}`.trim()}>
      {React.cloneElement(children, {
        'aria-describedby': visible ? tooltipId : undefined,
        onMouseEnter: (e: React.MouseEvent) => {
          setVisible(true);
          children.props.onMouseEnter?.(e);
        },
        onMouseLeave: (e: React.MouseEvent) => {
          setVisible(false);
          children.props.onMouseLeave?.(e);
        },
        onFocus: (e: React.FocusEvent) => {
          setVisible(true);
          children.props.onFocus?.(e);
        },
        onBlur: (e: React.FocusEvent) => {
          setVisible(false);
          children.props.onBlur?.(e);
        },
      })}
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          className={`pointer-events-none absolute z-50 ${positionClass} rounded-lg border border-slate-200 bg-slate-900 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg whitespace-nowrap dark:border-white/15 dark:bg-[#1E293B] dark:text-slate-100`}
        >
          {content}
        </span>
      )}
    </span>
  );
};
