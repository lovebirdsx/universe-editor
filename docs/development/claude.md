# Claude使用相关注意事项

* 目前context到了之后，token消耗明显会加快，建议将压缩控制在200k，在~/.claude/settings.json中加入如下配置

``` json
{
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"
  },
}
```
