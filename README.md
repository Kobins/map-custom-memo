# Map Custom Memo

브라우저 기반 지도 메모 도구입니다.  
프로젝트(`.mapproj`)와 업로드한 지도 이미지는 프론트엔드가 아닌 서버의 `/projects/` 경로에서 관리합니다.

## 실행

```bash
py server.py 4173
```

브라우저에서 `http://localhost:4173` 접속

개발 중에는 `index.html`, `app.js`, `styles.css` 변경 시 브라우저가 자동 새로고침됩니다.

## 서버 저장 구조

- 프로젝트 파일: `projects/*.mapproj`
- 이미지 파일: `projects/assets/*`

## 주요 동작

- `서버에 저장` 버튼: 현재 프로젝트를 서버의 `.mapproj` 파일로 저장
- `서버 목록 새로고침` 버튼: 서버 프로젝트 목록 갱신
- 왼쪽 프로젝트 목록 클릭: 서버에 저장된 프로젝트 로드
- 지도 이미지 선택: 서버로 업로드 후 프로젝트의 `map.imagePath`에 서버 경로 저장
