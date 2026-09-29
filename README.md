# Luggit

A Git diff panel for Obsidian. Review staged changes, working changes, and files from recent commits, and resolve note conflicts while preserving both alternatives. Use Obsidian Git or your usual Git tools for repository setup, staging, commits, and synchronization.

Desktop only. Requires Obsidian 1.7.2 or later and an installed Git executable. The vault itself must be the repository root; inherited repositories are refused.

Luggit is independent and is not affiliated with or endorsed by the Git Project. See [NOTICE.md](NOTICE.md) for the logo's attribution, license, and trademark notice.

[한국어 설명](#한국어)

## Installation

### From the community plugin directory

1. Open **Settings → Community plugins** and turn off Restricted mode if needed.
2. Select **Browse**, search for **Luggit**, then select **Install** and **Enable**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/lugglory/luggit/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/luggit/`.
3. Restart Obsidian and enable **Luggit** under **Settings → Community plugins**.

Release assets are built by GitHub Actions and carry [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds). Verify a download with `gh attestation verify main.js --repo lugglory/luggit`.

## Review changes

The **Git changes** panel opens in the right sidebar. Reopen it from the ribbon or the **Git 변경사항 패널 열기** command.

- **Staged / 스테이지됨** and **Changed / 변경됨** retain their separate lists and diffs. These are views of Git's index and working files, not staging controls.
- **Recently changed files / 최근 변경한 파일** lists up to 30 paths from the latest 30 first-parent commits. Select a file to see the last commit that changed that file, including deleted files.
- Select a section title to collapse it. File rows show names; tooltips and diff titles show full paths.
- Diffs include line numbers, selectable text, path copying, and change copying. Click an existing note's diff to open its editor. Long diffs display the first 3,000 rows; copying includes all loaded changes.
- Lists refresh from vault events and local `.git` / configuration-folder changes. Workspace layout changes are ignored. The **변경사항 새로고침** command refreshes locally.

There are no commit, push, pull, stage, unstage, discard, or repository-creation actions. Startup pull and exit push have been removed. Previously saved automatic-sync settings are ignored, even if enabled. No quit handler is registered. The only setting is the Git executable.

## Preserve note conflicts

Conflicted files show **U** and a **내용 보존하며 충돌 해결** button.

1. Open the conflict preview. Open text editors are saved and checked first.
2. For UTF-8 Markdown/text notes with valid conflict markers, the preview keeps both alternatives in each conflict and leaves surrounding content unchanged. Duplicate text and contradictory statements may remain intentionally. The ancestor in diff3 conflicts is preserved in the backup, not added to the resulting note.
3. Select **적용하고 해결로 표시** to back up the originals, apply the preview, and stage only this file to mark it resolved. Other staged files remain staged. Luggit never commits, continues a merge/rebase, or pushes; finish that work with Obsidian Git or another Git tool.
4. **원본만 백업** saves the originals without editing or staging. Cancel, Escape, or closing the preview applies nothing.

YAML-frontmatter conflicts, binary attachments, unsupported encodings/formats, absent working files, malformed markers, and differing alternatives without markers require manual review. Luggit offers backup only for these cases. Symlinks, submodules, and repositories with an external Git directory require an external tool and are not written.

Every backup is a separate directory under `<vault>/.git/luggit-backups/conflict-*`. `metadata.json` identifies the original path and available versions: `base.blob` (ancestor), `ours.blob` (Git stage 2), `theirs.blob` (stage 3), and `working.blob` (working file before applying). Missing versions are recorded as null. Blob files contain the original bytes; copy the desired version to a new filename with the original extension to inspect or restore it. During rebase, Git's stage labels do not necessarily mean “my device” and “the other device.”

The completion/error notice includes the backup location. **These backups are local, are not Git-synchronized, and remain until you remove them.** Copy them elsewhere if you need off-device recovery. Deleting `.git` also deletes these backups.

A changed working file or conflict index invalidates the preview. Git's index lock prevents overlapping normal Git writes while applying. If writing or staging fails, backups remain and the real index is not partially staged; inspect the current note and reopen the conflict preview.

## Permissions

- Runs the configured Git executable with argument arrays, without a shell. Luggit does not invoke network commands or collect telemetry.
- Reads Git data and local files; watches `.git` and the configuration folder. Conflict resolution writes backup files and temporary indexes inside `.git`, modifies the selected note through Obsidian, and updates the index only on explicit apply.
- Clipboard writes occur only when selecting a copy button. The clipboard is never read.
- No automatic sync or exit-status local storage. Settings retain only the Git executable when next saved.

## Development

```sh
npm ci
npm run build
npm test
npm run test:ui
```

`main.js` is generated and attached to releases, not tracked. Tests use temporary Git repositories and a hidden Electron window with an Obsidian API fixture. They do not replace testing inside a real Obsidian vault; see [QA.md](QA.md). To release, run `npm version patch` (or `minor` / `major`) and `git push --follow-tags`.

## 한국어

Luggit은 **메모의 Git diff를 검토하고 충돌 내용을 보존하는 패널**입니다. 저장소 설정·일반 스테이지 작업·커밋·동기화는 Obsidian Git이나 외부 Git 도구에 맡깁니다.

### 설치와 사용

데스크톱 Obsidian 1.7.2 이상과 Git이 필요하며, 보관함 자체가 Git 저장소 루트여야 합니다. 릴리즈의 `main.js`, `manifest.json`, `styles.css`를 보관함의 `.obsidian/plugins/luggit/`에 넣고 플러그인을 활성화하세요.

- **스테이지됨**, **변경됨**, **최근 변경한 파일** 목록과 접기/펼치기를 유지합니다. 파일별 diff, 줄 번호, 경로·변경 내용 복사, 편집기로 열기를 지원합니다.
- 최근 파일은 현재 브랜치의 최근 30개 커밋(첫 부모 이력)에서 최대 30개 경로를 추출합니다. 클릭하면 그 파일을 마지막으로 변경한 커밋 한 건의 diff를 보여줍니다. 삭제된 파일도 조회할 수 있습니다.
- 커밋 입력창과 commit·push·pull·stage·unstage·변경 버리기·저장소 생성 기능은 없습니다. **시작 시 Pull과 종료 시 Push는 기존 설정이 켜져 있어도 실행하지 않습니다.**
- 파일 변경에 따른 로컬 목록 자동 갱신은 유지합니다. 필요하면 명령 팔레트의 `변경사항 새로고침`을 사용하세요. 설정에는 Git 실행 파일만 남습니다.

### 내용 보존 충돌 해결

충돌 파일은 `U`로 표시하며, 옆의 **내용 보존하며 충돌 해결** 버튼으로 미리보기를 엽니다. 먼저 열린 텍스트 문서를 저장하고 저장 내용을 확인합니다.

일반 UTF-8 메모(`.md`, `.markdown`, `.txt`)는 충돌 구간의 양쪽 내용을 순서대로 이어 붙입니다. 충돌 밖의 내용·공백·줄바꿈은 유지하고, 중복을 임의로 제거하지 않습니다. 서로 모순되는 문장이 남을 수 있으므로 미리보기를 확인하세요. diff3의 공통 조상 내용은 결과에 합치지 않고 별도로 백업합니다.

**적용하고 해결로 표시**를 누르면 기준·양쪽 원본·현재 편집본을 백업하고 결과를 적용한 뒤 **해당 파일만 stage**합니다. 충돌 해결을 Git에 기록하기 위한 예외입니다. 다른 파일의 스테이지 상태는 유지하며 커밋·병합/rebase 계속·push는 실행하지 않습니다.

**원본만 백업**은 파일과 스테이지 상태를 바꾸지 않습니다. YAML 속성 충돌, 바이너리 첨부파일, 지원하지 않는 형식/인코딩, 현재 파일이 없는 충돌, 잘못된 충돌 표식, 양쪽 내용이 다른데 표식이 없는 파일은 백업 후 외부 도구에서 직접 검토하고 해결하세요. 심볼릭 링크·서브모듈·외부 Git 디렉터리를 사용하는 저장소에는 자동으로 쓰지 않습니다.

백업 위치는 **보관함의 `.git/luggit-backups/conflict-*`**이며 완료/오류 알림에 전체 경로를 표시합니다. `metadata.json`에는 원래 경로와 버전별 파일명이 기록됩니다. `base.blob`은 기준, `ours.blob`과 `theirs.blob`은 Git의 양쪽 버전, `working.blob`은 적용 직전 파일의 원본 바이트입니다. 없는 버전은 null로 기록합니다. 복구할 버전을 원래 확장자를 가진 새 파일로 복사해 확인할 수 있습니다. rebase 중에는 ours/theirs가 내 기기/상대 기기를 뜻하지 않을 수 있습니다.

**백업은 자동 삭제하지 않으며 Git으로 동기화되지 않습니다.** 다른 기기에서도 보존하려면 별도로 복사하세요. `.git` 폴더를 삭제하면 이 백업도 사라집니다.

미리보기 후 파일이나 충돌 상태가 바뀌면 적용을 중단합니다. 적용 중에는 Git 인덱스 잠금을 사용합니다. 적용/스테이지 실패 시 백업은 남으며, 실제 인덱스에 부분적으로 적용하지 않습니다. 현재 문서를 확인한 후 다시 미리보기를 여세요.

## License

[MIT](LICENSE). Git logo attribution and terms: [NOTICE.md](NOTICE.md).
