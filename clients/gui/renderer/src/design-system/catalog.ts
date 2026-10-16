// 由 design-system/registry.json 生成；运行 pnpm --dir clients/gui design:sync。
// 只记录角色与定义名，数值始终从生产 CSS 读取。
export const tokenGroups = [
  {
    "title": "文字",
    "tokens": [
      [
        "--text-ui-lg",
        "输入与强调正文"
      ],
      [
        "--text-ui-base",
        "正文"
      ],
      [
        "--text-ui-caption",
        "控件标签"
      ],
      [
        "--text-ui-sm",
        "说明"
      ],
      [
        "--text-ui-xs",
        "辅助信息"
      ],
      [
        "--line-height-ui",
        "公共内容行高"
      ],
      [
        "--line-height-ui-sm",
        "紧凑说明行高"
      ]
    ]
  },
  {
    "title": "表面与反馈",
    "tokens": [
      [
        "--color-background",
        "页面背景"
      ],
      [
        "--color-composer",
        "输入表面"
      ],
      [
        "--color-foreground",
        "主要文字"
      ],
      [
        "--color-foreground-subtle",
        "次要文字"
      ],
      [
        "--color-border",
        "分隔与边框"
      ],
      [
        "--color-button-surface",
        "次要按钮"
      ],
      [
        "--color-button-hover",
        "按钮悬停"
      ],
      [
        "--color-destructive",
        "错误反馈"
      ]
    ]
  },
  {
    "title": "尺寸与间距",
    "tokens": [
      [
        "--spacing-control",
        "标准控件"
      ],
      [
        "--spacing-control-sm",
        "紧凑控件"
      ],
      [
        "--spacing-inline",
        "相邻内容"
      ],
      [
        "--spacing-field",
        "内容块"
      ],
      [
        "--spacing-section",
        "分区"
      ]
    ]
  },
  {
    "title": "形状与动效",
    "tokens": [
      [
        "--radius-control",
        "控件"
      ],
      [
        "--radius-button",
        "操作按钮与下拉触发器"
      ],
      [
        "--radius-overlay",
        "浮层和决策卡片"
      ],
      [
        "--radius-composer",
        "输入区"
      ],
      [
        "--motion-fast",
        "控件反馈"
      ],
      [
        "--focus-width",
        "焦点描边"
      ],
      [
        "--radius-inset",
        "表面内的预览内容"
      ],
      [
        "--radius-pill",
        "胶囊或圆形动作"
      ]
    ]
  }
] as const;
export const baseCandidate = {
  "id": "desktop-core",
  "version": "0.1.2",
  "foundations": [
    "文字",
    "表面与反馈",
    "尺寸与间距",
    "形状与动效"
  ],
  "primitives": [
    "Button",
    "ActionButton",
    "Switch",
    "Select",
    "Feedback"
  ],
  "compositions": [
    "SettingsPage",
    "SettingsSection",
    "SettingsGroupCard",
    "SettingsRow",
    "SettingsSelect",
    "SettingsSegmentedTabs",
    "SettingsDisclosure",
    "DecisionCard",
    "ApprovalRequest",
    "CollapsibleText"
  ],
  "patterns": [
    "P-SETTINGS",
    "P-DECISION"
  ],
  "acceptance": [
    "角色引用现有生产来源；目录不存数值副本",
    "公共控件覆盖默认、禁用、处理中、失败和待确认",
    "设置组合挂载真实 SettingsPage 上下文；不只展示脱离页面的库默认",
    "明暗、14/18 字号、宽/窄与键盘交互有独立运行断言",
    "决策与长文本保留原权威状态、全文和焦点可达性",
    "设置单选使用公共control尺寸与navigation圆角；普通设置开关使用default，不自行降为sm",
    "活跃设置说明保留独立角色、对比度偏好与自定义前景色，不连带修改禁用或过程信息"
  ],
  "limits": [
    "候选集不是已冻结 Base，不代表用户视觉验收完成",
    "证据仅覆盖生产 renderer 组件和本地 fixture，不覆盖 Core、真实供应商或安装包",
    "未覆盖全仓组件、其它平台和所有自定义主题；未完成独立做题实验"
  ]
} as const;
