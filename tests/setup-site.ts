// 테스트는 실제 값 대신 예시 값으로 돈다 — 테스트·fixture에 실제 회사·고객사 표기를 쓰지 않게 (src/core/site-config.ts)
import { EXAMPLE_SITE, setSiteConfig } from '../src/core/site-config';

setSiteConfig(EXAMPLE_SITE);
