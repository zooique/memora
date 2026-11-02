/**
 * yauzl 最小类型声明（宿主压缩包导入专用）
 *
 * 为什么手写：`@types/yauzl` 需联网安装，当前离线环境不可得（`ERR_PNPM_NO_OFFLINE_META`）。
 * 本声明只覆盖导入流水线实际用到的 API 表面（lazyEntries 逐条读取模式），
 * 不追求完整覆盖上游类型——新增用法时须同步补此处，否则类型门禁会红（属预期护栏）。
 */
declare module 'yauzl' {
  /** zip 条目元数据（中央目录记录） */
  export interface Entry {
    /** 条目在压缩包内的路径（目录条目以 `/` 结尾） */
    fileName: string;
    /** 声明的解压后字节数（可被恶意包伪造，读取时以实际累计为准） */
    uncompressedSize: number;
    /** 声明的压缩后字节数 */
    compressedSize: number;
    /** 外部文件属性（高 16 位在 Unix 下含文件模式，用于识别符号链接） */
    externalFileAttributes: number;
    /** 创建平台（高字节 3 = Unix） */
    versionMadeBy: number;
  }

  /** 打开后的 zip 文件对象（惰性逐条模式） */
  export interface ZipFile {
    /** 读取下一条目（配合 `entry` / `end` / `error` 事件） */
    readEntry(): void;
    /** 关闭文件句柄 */
    close(): void;
    /** 打开条目的解压流（仅在 entry 事件回调内调用） */
    openReadStream(
      entry: Entry,
      callback: (err: Error | null, stream: NodeJS.ReadableStream | null) => void,
    ): void;
    on(event: 'entry', listener: (entry: Entry) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
  }

  /** 打开选项（只声明本仓用到的键） */
  export interface OpenOptions {
    /** 逐条惰性读取（防止一次性把全部条目载入内存） */
    lazyEntries?: boolean;
    /** 读完自动关闭句柄 */
    autoClose?: boolean;
    /** 条目名按字符串解码（默认 true；关掉会得到 Buffer） */
    decodeStrings?: boolean;
    /** 拒绝不合法条目名（如含 `\`） */
    strictFileNames?: boolean;
    /** 尺寸断言（默认 true）：会在业务层之前报「声明尺寸与实际字节不符」，
     *  关掉后尺寸上限判据全部归本仓（本仓需按实际字节二次校验，见 zipImport 说明） */
    validateEntrySizes?: boolean;
  }

  /**
   * 打开 zip 文件
   * @param path zip 绝对路径
   * @param options 打开选项
   * @param callback 打开结果
   */
  export function open(
    path: string,
    options: OpenOptions,
    callback: (err: Error | null, zipFile?: ZipFile) => void,
  ): void;
}
