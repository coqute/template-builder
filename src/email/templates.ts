import type { EmailTemplate } from './types';

const GREETING = '안녕하세요.\n예시아이티 박민수입니다.';
const CLOSING = '감사합니다.';

const PRODUCTS = [
  'Job Manager',
  '서버모니터링',
  'APM',
  'NMS 콘솔',
  '웹 점검',
  '데이터베이스',
  '쿠버네티스',
  '로그 모니터링',
];
const CONTRACT_TYPES = ['POC', '유상', '무상'];
const SERVICE_TYPES = ['설치형', 'SaaS', '설치형, SaaS'];

/** ① 제조사 기술 문의 — to example.com. 구분/상세내용 표 + 요청내용 자유 본문 */
const creInquiry: EmailTemplate = {
  id: 'tech-inquiry',
  name: '제조사 기술 문의',
  recipientHint: 'support@vendor.example',
  recipientCc: ['sales@vendor.example', 'biz@vendor.example'],
  subjectPattern: '[예시IT] {topic} 문의 ({customer})',
  greeting: GREETING,
  closing: CLOSING,
  note: '제조사 지원팀에 고객 기술 문의를 전달하는 표준 양식. 표는 폼으로, 요청내용은 본문에 이미지 포함 자유 작성.',
  sections: [
    {
      title: '',
      fields: [
        {
          key: 'topic',
          label: '문의 주제(제목용)',
          type: 'text',
          placeholder: '사용자 지정 분류 필드값',
          required: true,
          subjectOnly: true,
          wide: true,
        },
      ],
    },
    {
      title: '',
      fields: [
        {
          key: 'issue',
          label: '이슈',
          type: 'text',
          required: true,
          bodyLead: true,
          wide: true,
          placeholder: '예: 보고서 CSV 내려받기 실패 안내 문구 노출 및 기능 사용 불가',
        },
      ],
    },
    {
      title: '기본 정보',
      fields: [
        { key: 'requestDate', label: '요청일자', type: 'date', default: 'today', required: true },
        { key: 'customer', label: '고객사명', type: 'text', placeholder: 'ABZ+', required: true },
        { key: 'project', label: '프로젝트명', type: 'text', placeholder: '관제개발팀' },
        { key: 'serverOs', label: '수집서버 OS 및 버전', type: 'text', placeholder: 'RHEL 8.10', wide: true },
        { key: 'serverSpec', label: '수집서버 스펙', type: 'text', default: '-' },
        { key: 'product', label: '문의 제품', type: 'select', options: PRODUCTS, required: true },
      ],
    },
    {
      title: '제조사 정보',
      fields: [
        { key: 'contractType', label: '계약 유형', type: 'select', options: CONTRACT_TYPES },
        { key: 'serviceType', label: '서비스 유형', type: 'select', options: SERVICE_TYPES },
        {
          key: 'serverVersion',
          label: '수집서버 버전',
          type: 'text',
          placeholder: 'collector-x.y.z',
          wide: true,
        },
        {
          key: 'agentVersion',
          label: '에이전트 버전',
          type: 'text',
          placeholder: 'job-manager-x.y.z',
          wide: true,
        },
        { key: 'logFile', label: '로그파일', type: 'text', default: '-' },
      ],
    },
  ],
  hasBody: true,
  bodyLabel: '요청내용',
  bodyPlaceholder: '문의 배경과 구체적 질문을 작성하세요. 화면 캡처 이미지·글머리 기호 사용 가능.',
};

/** ② 라이선스 키 전달 — to 고객 */
const licenseDelivery: EmailTemplate = {
  id: 'license-delivery',
  name: '라이선스 키 전달',
  subjectPattern: '[예시IT] 제조사 수집서버 라이선스 키 전달 ({customer})',
  greeting: GREETING,
  closing: CLOSING,
  note: '발급된 제조사 수집서버 라이선스 키를 고객에게 전달. 본문에 추가 안내가 필요하면 작성.',
  sections: [
    {
      title: '',
      fields: [
        { key: 'licenseType', label: '유형', type: 'text', default: 'POC용' },
        { key: 'customer', label: '최종고객', type: 'text', placeholder: '에이비제트플러스', required: true },
        { key: 'project', label: '프로젝트명', type: 'text', placeholder: 'IDC서비스운영팀(PoC)' },
        { key: 'startDate', label: '시작일', type: 'date' },
        { key: 'endDate', label: '종료일', type: 'date' },
        { key: 'serverIp', label: '수집서버 IP', type: 'text', wide: true },
        { key: 'licenseKey', label: '라이선스', type: 'textarea', required: true, placeholder: '라이선스 키 문자열', wide: true },
      ],
    },
  ],
  hasBody: true,
  bodyLabel: '안내사항',
  bodyPlaceholder: '예: 수집서버 설치에 필요하오니 복사가 가능하도록 부탁드립니다.',
};

/** ③ 설치파일·에이전트 전달 — 다운로드 링크는 본문 자유 작성 */
const installDelivery: EmailTemplate = {
  id: 'install-delivery',
  name: '설치파일·에이전트 전달',
  subjectPattern: '[예시IT] {product} 설치파일 전달 ({customer})',
  greeting: GREETING,
  closing: CLOSING,
  note: '수집서버/MariaDB/서버모니터링 에이전트 등 설치파일 다운로드 링크를 전달. 파일명·버전·링크는 본문에 작성.',
  sections: [
    {
      title: '',
      fields: [
        { key: 'customer', label: '고객사', type: 'text', placeholder: 'ABZ+', subjectOnly: true },
        { key: 'product', label: '전달 대상', type: 'text', placeholder: '제조사 수집서버', required: true, subjectOnly: true },
      ],
    },
  ],
  hasBody: true,
  bodyLabel: '전달 내용',
  bodyPlaceholder: '예: 수집서버 설치파일 다운 링크 : https://...\nMariaDB(v11.4.10) : https://...',
};

/** ④ 출입 정보 전달 */
const accessInfo: EmailTemplate = {
  id: 'access-info',
  name: '출입 정보 전달',
  subjectPattern: '[예시IT] 출입 정보 전달드립니다.',
  greeting: GREETING,
  closing: CLOSING,
  note: '현장 출입 신청용 인적 정보 전달.',
  renderStyle: 'bullets',
  sections: [
    {
      title: '',
      fields: [
        { key: 'company', label: '회사', type: 'text', default: '예시아이티' },
        { key: 'name', label: '이름', type: 'text', default: '박민수', required: true },
        { key: 'phone', label: '연락처', type: 'text', placeholder: '010-0000-0000' },
        { key: 'email', label: '이메일', type: 'text', default: 'author@example.com' },
      ],
    },
  ],
  hasBody: false,
};

/** ⑤ 고객 기술 답변 (자유형) — 표 없이 본문 주력 */
const techAnswer: EmailTemplate = {
  id: 'tech-answer',
  name: '고객 기술 답변/안내',
  subjectPattern: '[예시IT] {topic} ({customer})',
  greeting: GREETING,
  closing: CLOSING,
  note: '고객 문의에 대한 기술 답변·가이드. 절차/설정/명령어를 본문에 자유 작성 (이미지 포함).',
  sections: [
    {
      title: '',
      fields: [
        { key: 'customer', label: '고객사', type: 'text', placeholder: 'ABZ+', subjectOnly: true },
        { key: 'topic', label: '제목', type: 'text', placeholder: '에이전트 타이머 설정 방법 안내', required: true, subjectOnly: true },
      ],
    },
  ],
  hasBody: true,
  bodyLabel: '내용',
  bodyPlaceholder: '답변·안내 내용을 작성하세요. 설정값/명령어/절차/화면 캡처 포함 가능.',
};

/** ⑥ 파트너 사이트 계정 요청 — to example.com */
const partnerAccount: EmailTemplate = {
  id: 'partner-account',
  name: '파트너 사이트 계정 요청',
  recipientHint: 'support@vendor.example',
  subjectPattern: '[예시IT] 제조사 파트너 사이트 계정 생성 요청',
  greeting: GREETING,
  closing: CLOSING,
  note: '제조사 파트너 사이트 계정 생성/권한 요청.',
  sections: [
    {
      title: '',
      fields: [
        { key: 'company', label: '회사', type: 'text', default: '예시아이티' },
        { key: 'contact', label: '담당자', type: 'text', default: '박민수', required: true },
        { key: 'email', label: '이메일', type: 'text', default: 'author@example.com', required: true },
        { key: 'role', label: '요청 권한', type: 'text', placeholder: '파트너 일반 계정' },
      ],
    },
  ],
  hasBody: true,
  bodyLabel: '요청 사항',
  bodyPlaceholder: '계정 생성/권한 요청 상세 내용을 작성하세요.',
};

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  creInquiry,
  licenseDelivery,
  installDelivery,
  accessInfo,
  techAnswer,
  partnerAccount,
];

export function getTemplate(id: string): EmailTemplate | undefined {
  return EMAIL_TEMPLATES.find((t) => t.id === id);
}

export const DEFAULT_TEMPLATE_ID = creInquiry.id;
