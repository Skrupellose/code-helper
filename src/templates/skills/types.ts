export interface SkillTemplate {
  /**
   * Skill frontmatter 中的稳定名称。
   * 项目级注册目录默认与该名称保持一致。
   */
  name: string;
  /**
   * 三类 agent 工具下的项目级 Skill 目录名。
   * 该字段必须是单层目录名，不能包含路径分隔符。
   */
  directoryName: string;
  fileName: string;
  content: string;
}
