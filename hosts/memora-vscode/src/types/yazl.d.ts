/**
 * yazl 最小类型声明（仅测试夹具用）
 *
 * 为什么手写：`yazl` 无自带类型，`@types/yazl` 需联网安装（当前离线环境不可得）。
 * 本声明只覆盖压缩包测试夹具实际用到的 API 表面（addBuffer / addEmptyDirectory / end），
 * 生产代码不依赖 yazl（它只在 devDependencies）。
 */
declare module 'yazl' {
  /** 条目写入选项（只声明测试用到的键） */
  export interface AddBufferOptions {
    /** 上次修改时间 */
    mtime?: Date;
    /** Unix 文件模式（高 16 位进 external attributes；0o120777 可造符号链接条目） */
    mode?: number;
    /** 是否 deflate 压缩（默认 true） */
    compress?: boolean;
  }

  /** zip 写入器 */
  export class ZipFile {
    /** 输出流（调用 end 后产出 zip 字节） */
    readonly outputStream: NodeJS.ReadableStream;
    /** 追加一个内存缓冲区条目 */
    addBuffer(buffer: Buffer, metadataPath: string, options?: AddBufferOptions): void;
    /** 追加一个空目录条目（路径自动补尾斜杠） */
    addEmptyDirectory(metadataPath: string, options?: AddBufferOptions): void;
    /** 收尾（此后 outputStream 才能完整读完） */
    end(): void;
  }
}
