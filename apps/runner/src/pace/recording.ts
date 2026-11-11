export type KeyClass = 'space' | 'backspace' | 'other';
export type TargetKind =
  | 'button'
  | 'link'
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'other';
export interface Target {
  kind: TargetKind;
  hasValue?: boolean; // fields only, at focusin
  options?: number; // select / radio group
  picked?: number; // on change
  inDescription?: boolean; // inside the measured description element
}
export interface Ctx {
  path: string;
  dialog: boolean;
  progress: number | null;
}
export interface RecordedEvent {
  t: number; // performance.timeOrigin + performance.now(), ms
  type:
    | 'pointermove'
    | 'pointerover'
    | 'pointerdown'
    | 'pointerup'
    | 'mousemove'
    | 'mousedown'
    | 'mouseup'
    | 'click'
    | 'wheel'
    | 'keydown'
    | 'keyup'
    | 'focusin'
    | 'change'
    | 'scroll';
  trusted: boolean;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  mx?: number;
  my?: number;
  button?: number;
  pointerType?: string;
  dy?: number;
  dm?: number;
  key?: KeyClass; // key events only — never the key itself
  target: Target;
  ctx: Ctx;
}
export interface PageInfo {
  t: number;
  ctx: Ctx;
  desc: { chars: number; height: number } | null;
  win: {
    screenX: number;
    screenY: number;
    outerWidth: number;
    outerHeight: number;
    innerWidth: number;
    innerHeight: number;
  };
  screen: { width: number; height: number };
  dpr: number;
}
export interface RecorderBatch {
  pageId: string;
  jobKey: string | null;
  page?: PageInfo;
  events: RecordedEvent[];
}
export type Source = 'linkedin' | 'practice' | 'typing' | 'test-page';
export type Actor = 'author' | 'runner';
export interface Recording {
  version: 1;
  actor: Actor;
  source: Source;
  sittingId: string;
  jobKey: string;
  pages: PageInfo[];
  events: RecordedEvent[];
}
