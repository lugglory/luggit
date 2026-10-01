# Lugdiff

Formerly Luggit. 기존 Luggit에서 업데이트하면 됩니다.

Review your Obsidian notes with Git diffs. Lugdiff shows staged changes, working changes, and files from recent commits in the sidebar. Use it alongside Obsidian Git for commits and sync.

[한국어](#한국어)

## Install

Search for **Lugdiff** in **Settings → Community plugins → Browse**, then install and enable it.

For manual installation, copy `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/lugglory/luggit/releases/latest) into `<vault>/.obsidian/plugins/luggit/`.

Requires desktop Obsidian 1.7.2+ and Git. The vault folder must be the Git repository root.

## Use

Click a file in the sidebar to see its diff. You can copy the changes or open the note for editing. The lists update as files change. Recent files show the last commit that changed each file.

In **Settings → Lugdiff**, set how many recent commits to search (1–1000, default 30). Changes apply immediately. The recent file list shows up to 30 distinct files.

For a conflicted note, click **내용 보존하며 충돌 해결** to preview a merge that keeps both sides. Each conflict keeps Git’s `ours` block followed by `theirs`; surrounding text stays in place. Duplicates may remain.

Nothing is applied until you choose **적용하고 해결로 표시**. Lugdiff backs up the originals, writes the result, and stages that file. Commit and sync with Obsidian Git afterward. Opening the preview saves open text documents first.

YAML property conflicts and attachments need manual review; **원본만 백업** saves their originals. Backups are stored in `.git/luggit-backups` inside the vault and are not synced by Git.

## 한국어

Obsidian에서 메모의 Git 변경사항을 보는 사이드바 플러그인입니다. **스테이지됨**, **변경됨**, **최근 변경한 파일**을 보여줍니다. 커밋과 동기화는 Obsidian Git을 함께 사용하면 됩니다.

### 설치

**설정 → 커뮤니티 플러그인 → 탐색**에서 **Lugdiff**을 검색해 설치하세요. 수동 설치는 [최신 릴리즈](https://github.com/lugglory/luggit/releases/latest)의 `main.js`, `manifest.json`, `styles.css`를 보관함의 `.obsidian/plugins/luggit/`에 넣으면 됩니다.

데스크톱 Obsidian 1.7.2 이상과 Git이 필요합니다. 보관함 폴더가 Git 저장소의 루트여야 합니다.

### 사용

파일을 누르면 diff가 열립니다. 변경 내용을 복사하거나 메모를 열어 편집할 수 있고, 파일 목록은 자동으로 갱신됩니다. 최근 파일을 누르면 그 파일을 마지막으로 변경한 커밋의 diff를 보여줍니다.

**설정 → Lugdiff → 최근 커밋 조회 개수**에서 조회할 커밋 수를 바꿀 수 있습니다(1~1000, 기본값 30). 변경하면 바로 반영되며, 최근 파일 목록은 중복을 제외한 최대 30개 파일을 표시합니다.

충돌한 메모는 **내용 보존하며 충돌 해결** 버튼으로 병합 결과를 미리 볼 수 있습니다. 충돌 구간마다 양쪽 내용을 Git의 `ours` → `theirs` 순서로 붙이고, 나머지 부분은 그대로 둡니다. 중복된 내용은 남을 수 있습니다.

**적용하고 해결로 표시**를 눌러야 원본 백업 → 내용 적용 → 해당 파일 스테이지를 진행합니다. 이후 커밋과 동기화는 Obsidian Git에서 하세요. 미리보기를 열 때는 먼저 열린 텍스트 문서를 저장합니다.

YAML 속성이나 첨부파일 충돌은 직접 검토해야 합니다. **원본만 백업**으로 원본들을 따로 보관할 수 있습니다. 백업은 보관함의 `.git/luggit-backups`에 저장되며 Git으로 동기화되지 않습니다.

## Development

```sh
npm ci
npm run build
npm test
npm run test:ui
```

## License

[MIT](LICENSE). Git logo attribution: [NOTICE.md](NOTICE.md).
