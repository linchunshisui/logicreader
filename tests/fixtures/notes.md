# LogicReader 测试文档

这是一份用于验证 **Markdown 阅读管线** 的样例文档，包含 GFM 表格、任务列表、代码块与 LaTeX 公式。

## 1. 论点与证据

注意力机制的引入本质上是对序列依赖建模的一次结构性简化。传统循环网络把历史压缩进固定长度的隐状态，
而注意力直接对全部位置建立两两交互。

> 引用：结构决定可并行性，可并行性决定训练吞吐。

### 1.1 证据表

| 模型 | BLEU | 训练时长 | 可并行 |
| --- | --- | --- | --- |
| RNN baseline | 26.3 | 6 天 | 否 |
| Attention | 28.4 | 3 天 | 是 |
| Attention + 大 batch | 29.1 | 2 天 | 是 |

### 1.2 任务列表

- [x] 抽取章节级论点
- [x] 建立锚点
- [ ] 全量抽取数据与定义

## 2. 代码

```ts
export function attend(query: number[], keys: number[][]): number[] {
  const scores = keys.map((key) => dot(query, key))
  const weights = softmax(scores)
  return weightedSum(weights, keys)
}
```

## 3. 公式

注意力权重定义为 $\alpha_i = \frac{\exp(e_i)}{\sum_j \exp(e_j)}$，其中 $e_i$ 是打分函数。

$$
\text{Attention}(Q,K,V) = \text{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
$$

## 4. 结论

综上，注意力把"顺序递归"替换为"直接两两交互"，在准确率与训练效率上同时获益。
