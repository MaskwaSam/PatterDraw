import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const OpenIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M3.5 7.5h6l2-2h9v13h-17z"/><path d="m3.5 10 17-.1-3 8.6h-14z"/></IconBase>
);
export const SaveIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M5 3.5h12l2 2V20H5z"/><path d="M8 3.5v6h8v-6M8 20v-7h8v7"/></IconBase>
);
export const SettingsIcon = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </IconBase>
);
export const SearchIcon = (props: IconProps) => (
  <IconBase {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></IconBase>
);
export const SizePositionIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></IconBase>
);
export const LibraryIcon = (props: IconProps) => (
  <IconBase {...props}>
    <g strokeWidth="1.25">
      <path d="M3 19a9 9 0 0 1 9 0 9 9 0 0 1 9 0" />
      <path d="M3 6a9 9 0 0 1 9 0 9 9 0 0 1 9 0" />
      <path d="M3 6v13M12 6v13M21 6v13" />
    </g>
  </IconBase>
);
export const ScreenshotIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 8.5h3l1.4-2h7.2l1.4 2h3v9H4z" />
    <circle cx="12" cy="13" r="3" />
    <path d="M4 5v2M4 5h2M20 5v2M20 5h-2M4 21v-2M4 21h2M20 21v-2M20 21h-2" />
  </IconBase>
);
export const ExportIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M5 11v9h14v-9"/></IconBase>
);
export const EquationIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M4 6h7M4 18h7M7.5 6v12M14 8l6 8M20 8l-6 8"/></IconBase>
);
export const MathToolsIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M4 18 18 4l2 2L6 20z"/><path d="m8 16-2-2m5-1-2-2m5-1-2-2"/><circle cx="6" cy="6" r="2.5"/></IconBase>
);
export const LassoIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M19.5 10.5c0 3.6-3.5 6.5-8 6.5S4 14.8 4 11.5 7.1 6 11.5 6s8 1.9 8 4.5Z"/><path d="M11.5 17c0 2.1-1.2 3.5-3 3.5-1.4 0-2.5-.8-2.5-2 0-1 .8-1.7 1.8-1.7"/></IconBase>
);
export const BucketFillIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m5 13 7-7 6 6-7 7H5z" />
    <path d="m9 9 6 6M18.5 16.5s-2 2.2-2 3.3a2 2 0 0 0 4 0c0-1.1-2-3.3-2-3.3Z" />
  </IconBase>
);
export const RulerIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M3.5 14.5 14.5 3.5l6 6-11 11z"/><path d="m8 13-2-2m5-1-2-2m5-1-2-2m3 5-2-2"/></IconBase>
);
export const ProtractorIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M3 18a9 9 0 0 1 18 0H3Z"/><path d="M12 18V9m-6.5 9 .8-3m11.4 3-.8-3m-7.8 3 .3-2m5.5 2-.3-2"/></IconBase>
);
export const MermaidIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/><path d="M6.5 9v4h11v2M17.5 9v3M14 12h7"/></IconBase>
);
export const SlidesIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="13" rx="1"/><path d="M8 21l4-4 4 4M8 9h8M8 12h5"/></IconBase>
);
export const BoardIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M7 8h10M7 12h6M7 16h8"/></IconBase>
);
export const FrameIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="7" y="7" width="10" height="10" rx="1"/></IconBase>
);
export const PdfIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M6 2.5h8l4 4V21H6z"/><path d="M14 2.5v4h4M8.5 11.5h7M8.5 15h7M8.5 18.5h4"/></IconBase>
);
export const HidePanelIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16m7-12-4 4 4 4"/></IconBase>
);
export const ShowPanelIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16m3-12 4 4-4 4"/></IconBase>
);
export const HideTopBarIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 10h17m-12 6 3.5-3.5 3.5 3.5"/></IconBase>
);
export const ShowTopBarIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 10h17m-12-3 3.5 3.5L15.5 7"/></IconBase>
);
export const HideBottomBarIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 14h17m-12-6 3.5 3.5L15.5 8"/></IconBase>
);
export const ShowBottomBarIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 14h17m-12 3 3.5-3.5 3.5 3.5"/></IconBase>
);
export const ChevronDownIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m7 9 5 5 5-5"/></IconBase>
);
export const PlusIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M12 5v14M5 12h14"/></IconBase>
);
export const MinusIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M5 12h14"/></IconBase>
);
export const UndoIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></IconBase>
);
export const RedoIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></IconBase>
);
export const PresentIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M3 4h18v12H3zM8 21l4-5 4 5"/></IconBase>
);
export const MorphIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="5" width="8" height="8" rx="1.5"/><rect x="12.5" y="11" width="8" height="8" rx="1.5"/><path d="m10 16 2 2 2-2M14 8l-2-2-2 2"/></IconBase>
);
export const RotateIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M19 8V3m0 0h-5m5 0-3.1 3.1A8 8 0 1 0 20 13"/></IconBase>
);
export const EnterFullscreenIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></IconBase>
);
export const ExitFullscreenIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4"/></IconBase>
);
export const MoreIcon = (props: IconProps) => (
  <IconBase {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></IconBase>
);
export const DuplicateIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></IconBase>
);
export const RotateClockwiseIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M19 7V3m0 4h-4"/><path d="M18.2 7A8 8 0 1 0 20 12"/></IconBase>
);
export const RotateCounterclockwiseIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M5 7V3m0 4h4"/><path d="M5.8 7A8 8 0 1 1 4 12"/></IconBase>
);
export const DragIcon = (props: IconProps) => (
  <IconBase {...props}><circle cx="8" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="18" r="1" fill="currentColor" stroke="none"/></IconBase>
);
export const PreviousIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m14 6-6 6 6 6"/></IconBase>
);
export const NextIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m10 6 6 6-6 6"/></IconBase>
);
export const UpIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m6 14 6-6 6 6"/></IconBase>
);
export const DownIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m6 10 6 6 6-6"/></IconBase>
);
export const CloseIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M6 6l12 12M18 6 6 18"/></IconBase>
);
export const TrashIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></IconBase>
);
export const LaserIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m14 4-2 8-8 2 6 2 2 6 2-8 8-2-6-2z"/></IconBase>
);
export const InkIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m4 19 4.5-1 9.7-9.7-3.5-3.5L5 14.5zM13.5 6l3.5 3.5"/></IconBase>
);
export const EyeIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/></IconBase>
);
export const EyeOffIcon = (props: IconProps) => (
  <IconBase {...props}><path d="m3 3 18 18M10.6 6.1A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16.7 16.7 0 0 1-2.2 2.8M6.2 6.2C3.8 7.8 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></IconBase>
);
