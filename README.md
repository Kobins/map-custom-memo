# Map Custom Memo

로컬 서버에서 동작하는 경량(바닐라 JS + Canvas2D) 지도 메모 웹앱입니다.

## 실행

```bash
python3 -m http.server 4173
# 브라우저에서 http://localhost:4173 접속
```

## 핵심 기능

- 프로젝트(.mapproj) 생성/불러오기/저장
- 프로젝트 세션 내 다중 프로젝트 스위칭
- 지도 이미지 오버레이 편집
- 레이어 시스템
  - draw 순서 변경
  - 레이어 visible / transparency / offset / local rotation / local scale
  - 뷰 전용 quick visibility / quick transparency
- 모드
  - `init-ruler`: 2점 클릭으로 1km 기준 픽셀 거리 저장
  - `view`: pan/zoom, 거리 측정, 반경 원 측정
  - `edit`: 마커/텍스트 레이어 인스턴스 추가·이동·삭제 및 속성 편집

## 프로젝트 포맷(.mapproj)

JSON 파일이며 이미지 자체는 저장하지 않고 상대경로(또는 파일명) 문자열만 저장합니다.
