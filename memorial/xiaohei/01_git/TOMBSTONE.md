# Tombstone: one photograph

这是小黑的照片墓碑。`01_git/dog_photo.jpg` 在本分支的第二条提交里被移除，
但照片仍是 Git 对象库里的 blob；tag `archive-2026-11-19` 指向还含它的提交。

| 项目 | 值 |
| --- | --- |
| 原始文件 | dog_photo.jpg |
| 字节数 | 295442 |
| SHA-256 | 36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5 |
| Git blob | 67b4832588e9a170159fdae121bfc66d7364d62f |
| 首次提交 | 49728e9cda7cbb1f7a11267f6efeaf84feff49e4 |
| Tag | archive-2026-11-19 |

## 取回

    git show archive-2026-11-19:memorial/xiaohei/01_git/dog_photo.jpg > dog_photo.jpg

或者：

    git cat-file blob 67b4832588e9a170159fdae121bfc66d7364d62f > dog_photo.jpg

取回后 SHA-256 应为 `36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5`。

## 原档案

- `01_git/blob_repo.bundle`：原始 `blob_repo` 的完整 bundle。
- `01_git/lfs_repo.bundle` + `01_git/lfs/objects/36/ea/…`：原始 LFS 通道的指针仓库与真实字节。
- `01_git/lfs_repo/LFS_TOMBSTONE.md`、`01_git/blob_repo/TOMBSTONE.md`：原档案里的说明副本。

不要对本仓库执行破坏性 `git gc`、重写包含照片的提交或强推。
