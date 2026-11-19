# Tombstone: one photograph

这是一张照片的墓碑。工作区里已经没有它了，但它仍然活在 Git 的对象库里。

| 项目 | 值 |
| --- | --- |
| 原始文件 | dog_photo.jpg |
| 字节数 | 295442 |
| SHA-256 | 36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5 |
| Git blob | 67b4832588e9a170159fdae121bfc66d7364d62f |
| 首次提交 | d81705ef11a3ead7d3f00086759889b7e7b515ac |
| Tag | memorial |

## 取回

    git cat-file blob 67b4832588e9a170159fdae121bfc66d7364d62f > dog_photo.jpg

或者：

    git show memorial:dog_photo.jpg > dog_photo.jpg

取回后校验：

    certutil -hashfile dog_photo.jpg SHA256

预期 SHA-256 为 36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5。

## 说明

blob 由 tag memorial 指向的提交保持可达。不要对这个仓库执行
git gc --prune=now 或重写历史，否则墓碑可能真的消失。
