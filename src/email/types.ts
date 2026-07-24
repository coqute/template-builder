export type EmailFieldType = 'text' | 'date' | 'select' | 'textarea';

export interface EmailField {
  key: string;
  label: string;
  type: EmailFieldType;
  options?: string[]; // type==='select'일 때
  default?: string; // 초기값. date 타입에서 'today'는 오늘로 프리필
  placeholder?: string;
  required?: boolean;
  /** true면 폼·제목에만 사용하고 본문 표에는 렌더하지 않음 (예: 제목용 주제) */
  subjectOnly?: boolean;
  /** true면 2단 폼에서 전폭(col-span-2) — 긴 값(버전/라이선스 등) */
  wide?: boolean;
  /** true면 표 행이 아니라 요청내용 본문 셀 서두에 `{label} : {value}` 굵게 렌더 (예: 이슈 요약) */
  bodyLead?: boolean;
  /** true면 표 위(인사말 아래)에 문단으로 렌더 — 라벨 없이 값만 (예: 기술 문의 도입 문장) */
  introLead?: boolean;
}

/** 표의 섹션 그룹 — title이 있으면 rowspan 좌측 라벨 셀 생성 */
export interface EmailSection {
  title: string;
  fields: EmailField[];
}

export interface EmailTemplate {
  id: string;
  name: string;
  recipientHint?: string; // Gmail to= 프리필 (예: support@vendor.example)
  recipientCc?: string[]; // 고정 CC (예: ['sales@vendor.example', 'biz@vendor.example'])
  /** '[예시IT] {topic} 문의 ({customer})' — {key}를 fieldValues로 치환 */
  subjectPattern: string;
  greeting: string;
  closing: string;
  sections: EmailSection[];
  /** 고정 필드 렌더 방식 — 'table'(구분/상세 표, 기본) | 'bullets'(글머리 리스트, 출입정보 등) */
  renderStyle?: 'table' | 'bullets';
  hasBody: boolean; // 자유 본문(요청내용) 영역 노출
  bodyLabel?: string; // 본문 행 라벨 (기본 '요청내용')
  bodyPlaceholder?: string;
  /** 설명/안내 (드롭다운 선택 시 표시) */
  note?: string;
  /** 자주 쓰는 본문 문구 — 본문 에디터 드롭다운으로 삽입 (팀 표준 문구 전파용) */
  bodyPresets?: string[];
  /** 표 최상단 헤더 행 [tableHeader[0] | tableHeader[1]] (예: ['구분','상세내용']). 생략 시 헤더 없음 */
  tableHeader?: [string, string];
}

/** 템플릿 JSON 원본 — greeting/closing 생략 시 로더가 프로필 파생값 주입 */
export type EmailTemplateData = Omit<EmailTemplate, 'greeting' | 'closing'> & {
  greeting?: string;
  closing?: string;
};

export interface EmailDocState {
  templateId: string;
  fieldValues: Record<string, string>;
  bodyHtml: string;
  /** 제목 직접 편집값 — 비어있으면 subjectPattern으로 자동 생성 */
  subject?: string;
}

export interface EmailRenderResult {
  subject: string;
  html: string;
  plain: string;
}
