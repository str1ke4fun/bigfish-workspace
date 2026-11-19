# Tombstone: one photograph (LFS pointer)

工作区里只保留一个 LFS 指针，真正的字节存放在本地 LFS 对象库中。
提交历史里，这张照片永远是一个 130 字节左右的指针。

## 指针内容

    version https://git-lfs.github.com/spec/v1
    oid sha256:36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5
    size 295442

## 取回

    git show memorial-lfs:dog_photo.jpg | git lfs smudge > dog_photo.jpg

如果对象不在本地，需要配置 LFS remote 后执行：

    git lfs fetch --all
    git lfs checkout

## 校验

    certutil -hashfile dog_photo.jpg SHA256

预期：36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5

## 说明

LFS 的 oid 就是原图内容的 SHA-256。指针本身就是一枚指纹：
即使原图不在手边，只要看到这三行，就知道它曾经以什么形态存在过。
