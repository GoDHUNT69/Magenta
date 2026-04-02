# Pre-Publish Tasks

## Code Hardening (extension.ts)
- [x] 1. Output channel + try/catch on all audit I/O
- [x] 2. Audit rename/delete handlers (`AuditedFileManager.renameFile`)
- [x] 3. Dynamic config reading (`getConfig()` replaces constants)
- [x] 4. `onDidChangeWorkspaceFolders` handler

## Package & Assets
- [x] 5. package.json — publisher, license, repo, icon, gallery banner, keywords, categories
- [x] 6. .vscodeignore — add `.magenta/**`
- [x] 7. Generate 128×128 icon → `images/icon.png`

## Documentation
- [x] 8. README.md — full rewrite for marketplace
- [x] 9. CHANGELOG.md — real 0.1.0 release notes

## Post-Implementation
- [x] 10. `npm run compile` — verify clean build (types + lint + esbuild all pass)

## Remaining Manual Steps (for you)
- [ ] Replace `YOUR_PUBLISHER_ID` in package.json with your marketplace publisher ID
- [ ] Replace `YOUR_USERNAME` in package.json (repository, bugs, homepage URLs)
- [ ] Replace `YOUR_USERNAME` in README.md (Building from Source section)
- [ ] Update CHANGELOG.md date (`2025-04-XX` → actual release date)
- [ ] Create publisher account at marketplace.visualstudio.com/manage
- [ ] Generate PAT from dev.azure.com with Marketplace publish scope
- [ ] `vsce package` — inspect VSIX contents
- [ ] `vsce publish`
- [ ] (Optional) Create open-vsx.org account + `ovsx publish`
- [ ] (Optional) Add 3 minimum tests for `looksLikeGenerated`, `classify`, `adjustLinesForEdit`
