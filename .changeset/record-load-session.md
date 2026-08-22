---
"@mcpeak/record": minor
---

record: 세션 파일을 읽기 전용으로 열어 스냅샷을 주는 `loadSession(path)` 을 `@mcpeak/record/external` 에 추가

세션 파일이 아니면 던지지 않고 `null` 을 준다. 프로젝트를 훑으며 "이게 세션인가" 를 묻는 판별기라(legacy 의 `loadCassette` 와 같은 자리), 아닌 파일이 정상 입력이기 때문이다. `readOnly: true` 로 열어 없는 경로에 빈 DB 를 만들지 않는다.
