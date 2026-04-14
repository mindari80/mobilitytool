# DLT GPS + SHP Network Viewer

## 프로젝트 개요

DLT 바이너리 로그에서 GPS/MM 위치, 경로 요청(TVAS), 음성안내(TTS) 로그를 추출하고, SHP(링크/노드) 데이터와 함께 지도에 시각화하는 브라우저 기반 도구.

- 메인 페이지: `dlt-map-viewer_v3.html`
- 핵심 모듈: `js/dlt-parser.js`, `js/extractor.js`, `js/tvas-parser.js`, `js/coordinate.js`, `js/map-viewer.js`, `js/shp-app.js`

## 개발 원칙: TDD (Test-Driven Development)

이 프로젝트는 **TDD 기반으로 개발**한다. 새 기능 추가·버그 수정·리팩토링 모두 테스트를 먼저 작성하고 구현을 맞추는 방식으로 진행한다.

### Red → Green → Refactor 사이클

1. **Red**: 실패하는 테스트부터 작성한다. 테스트는 동작(입력/출력)을 기술하며, 구현 세부는 드러내지 않는다.
2. **Green**: 테스트가 통과하는 최소한의 구현을 작성한다. 일단 통과시키는 게 목표이며, 조급하게 일반화하지 않는다.
3. **Refactor**: 테스트가 초록불인 상태에서 중복 제거·가독성 개선·구조 정리. 리팩토링 후 테스트가 여전히 통과하는지 확인.

### 규칙

- **구현 전 테스트 작성 금지 예외 없음**: 프로덕션 코드 변경은 반드시 실패하는 테스트가 선행한다. 버그 수정이라면 "그 버그를 재현하는 테스트"가 먼저.
- **한 번에 한 개 테스트만**: 여러 케이스를 동시에 쓰지 않는다. 하나 Red → Green → 다음 케이스.
- **테스트가 문서**: 테스트 이름은 동작을 설명한다. `parseDltTimestamp_with_wallclock_returns_Date` 같이.
- **외부 I/O는 격리**: 파일·네트워크·DOM은 테스트에서 직접 호출하지 않는다. 폴리필(`FakeFile` 등) 또는 fixture를 사용한다.
- **fixture는 `tests/fixtures/`에 작은 바이너리 조각으로 두고 재사용**한다. 대용량 실 로그는 커밋 금지.

## 테스트 실행

```bash
# 전체 테스트
npm test

# 특정 파일
node --test tests/dlt-parser.test.mjs

# watch 모드
node --test --watch tests/
```

Node 18+의 내장 `node:test` 러너를 사용한다. 외부 테스트 프레임워크는 도입하지 않는다.

## 디렉토리 구조

```
honor436.github.io/
├── js/                          # 프로덕션 코드 (ES modules)
│   ├── dlt-parser.js
│   ├── extractor.js
│   ├── tvas-parser.js
│   ├── coordinate.js
│   ├── map-viewer.js
│   └── shp-app.js
├── tests/                       # 테스트 코드
│   ├── fixtures/                # 테스트용 작은 바이너리/텍스트 조각
│   ├── dlt-parser.test.mjs
│   ├── extractor.test.mjs
│   ├── tvas-parser.test.mjs
│   └── coordinate.test.mjs
├── dlt-map-viewer_v3.html       # 메인 진입점
└── package.json                 # type: module, scripts.test
```

## 테스트 작성 가이드

### 순수 로직 (파서·좌표 변환)

파싱 로직(`parseDltTimestamp`, `parseRouteSummary`, `skCoordToWgs84` 등)은 입력 → 출력이 명확하므로 가장 먼저 테스트한다.

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDltTimestamp } from '../js/dlt-parser.js';

test('parseDltTimestamp wallclock format returns Date', () => {
  const d = parseDltTimestamp('2026/04/06 10:16:43.698');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 3);
  assert.equal(d.getMilliseconds(), 698);
});

test('parseDltTimestamp empty returns null', () => {
  assert.equal(parseDltTimestamp(''), null);
});
```

### 바이너리 포맷 (TVAS RS7/RD5)

스펙 기반 바이트 레이아웃 테스트는 fixture 바이너리로 검증한다.

- `tests/fixtures/rs7-sample.bin`: 최소한의 RS7 블록 (헤더 48B + 1 세그먼트 32B + 명칭 blob)
- 필드 하나마다 별도 테스트: `parseRouteSummary_header_count`, `parseRouteSummary_section_name_from_blob`, ...

### 파일 I/O·DOM

- **DLT 파일 파싱**: `FakeFile` 폴리필로 `File` API 흉내. 실제 `.dlt` fixture는 수십 KB 이내.
- **DOM 렌더링**: `jsdom` 없이, 렌더링 함수는 "데이터 → HTML 문자열" 또는 "데이터 → Leaflet 레이어 객체"를 반환하도록 분리하고, 반환값을 assert 한다.

## 회귀 테스트 필수 케이스 (현재까지 파악된 주요 함정)

다음 시나리오는 반드시 테스트로 고정한다. 과거에 버그가 발생한 지점이다.

- **RS7 헤더는 48바이트** (50 아님). 헤더 크기 오차 → 에너지/명칭 전부 깨짐.
- **RS7 데이터 레이아웃 순서**: Header(48) → 경로요약DATA(32×n) → 주요도로DATA(16×m) → 경로요약명칭blob → 주요도로명칭blob.
- **RS7 명칭은 현재 offset ~ 다음 offset** 범위로 읽는다 (null-terminated 아님).
- **RD5 헤더 40바이트 / 레코드 24바이트** + 마지막에 tollgate blob.
- **SK 좌표 → WGS84** 변환은 Bessel 중간 단계를 거친다. 직접 Bessel 생략 금지.
- **`initMap` 재호출 시** 기존 맵 `remove()` 후 재생성 → 이전에 연결된 `contextmenu` 이벤트 유실. `map-init` 이벤트로 재부착 필요.
- **DOM 요소 null 체크**: `stats-section`, `layer-panel` 등은 페이지마다 존재 여부가 다르므로 `textContent` 대입 전 반드시 null 가드.

## 변경 워크플로우

1. 이슈/기능 파악
2. 재현 또는 기대 동작을 나타내는 **실패 테스트 작성** (Red 확인)
3. 프로덕션 코드 수정으로 테스트 통과 (Green)
4. 리팩토링 (테스트 여전히 Green)
5. 관련 회귀 테스트가 있다면 추가로 실행
6. 수동 검증: `/DLTLOG/1020/` 등 실 로그로 브라우저에서 확인
7. 커밋 (테스트 파일 포함)

## 금지 사항

- 테스트 없이 프로덕션 코드 변경
- 실패한 테스트를 건너뛰거나 `skip`으로 감추는 행위 (원인을 해결하거나, 불필요하면 삭제)
- 테스트를 맞추기 위해 프로덕션 코드에 테스트 전용 분기 추가
- 대용량 실 DLT 로그를 `tests/fixtures/`에 커밋

## 참고 — 실 로그 수동 검증 경로

브라우저 통합 검증용 실 로그. 커밋 금지, `.gitignore` 대상:
- `/Users/a201010147/Documents/Project/Claude/honor436.github.io/DLTLOG/1020/1020.dlt`
