# 0.8.1 发布验证



360 项主项目测试、12 项 relay 测试、17 项 Android 单元测试及2项 Windows 打包冒烟通过；协议probe通过。功能真机验收基于0.8.0增量构建：MatePad原会话续聊、释放与草稿保留、只读同步和滚动恢复通过，全程不锁屏；0.8.1进行了版本提升、滚动归属保护、构建与同签名核对，未宣称重新完成OPPO或多台真机验收。

完整能力与验证见仓库 docs/OFFICIAL-DESKTOP-CONTROL.md、docs/TABLET-SIDEBAR-ALIGNMENT.md 和 docs/RELEASE-0.8.1.md。


## 产物 SHA256

- PaneFlow-Desktop-0.8.1-Setup.exe: `19ccf26dde9431ebfb126ad7963ac2d98081c910f30c6dd29587b34d3b9c3640`
- PaneFlow-Android-0.8.1.apk: `391fb43cb21ba4033ac3876646899f449399f55cff8a590fd43d2041f1ca8acb`

APK签名证书SHA256：`f73b8ce6a036f60e9d680b71f8b0ea4a05d8b3956a858f6e84338457cdca4ed0`，与此前已装机版本一致。Windows安装包ProductVersion为0.8.1，Android版本0.8.1/11；update.json引用两项相同哈希、尺寸与版本。

新增跨电脑滚动归属校验通过源码独立复核与构建；本轮不将单台平板验收称为多电脑真机通过。
