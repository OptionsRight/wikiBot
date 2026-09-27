# 第二领域配置演示

本目录是合成的设备借用领域，用来验证配置复用与跨域隔离，不代表真实第二领域验收通过。没有真实负责人批准、独立 bot、代表性题集和维护技能往返证据。

`manifest.json` 使用生产快照格式；以 `wiki` 为根目录运行：

```sh
npm run snapshot -- examples/second-domain/wiki examples/second-domain/manifest.json /tmp/wikibot-equipment-bundle.json
node --import tsx --test test/second-domain.test.ts
```

快照输出必须使用尚不存在的路径。测试只创建内存领域和本地模型替身，不连接真实 bot，不读取公司知识。

真实接入时由平台管理员创建独立领域并配置成员/知识管理员，由获准知识管理员配对 Wiki 目录，再经提交、逐题评估、人工复核、激活。业务和技术表达标签可以并存；默认技术优先，显式偏好覆盖默认，标签不授予权限。将示例名称、模型版本、知识和题集替换为批准内容；不得把本例的评估证据用于真实发布。
