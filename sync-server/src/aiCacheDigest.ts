// sync-server/src/aiCacheDigest.ts
// 云缓存一条内容的摘要：把「写在哪」（kind + key）、「谁写的」（writer）、「用什么公钥验的」
// （verifyKey）和内容本身一起算成 SHA-256，落库时存一列，读出来时交给客户端核对。
//
// 为什么要有（issue C6）：读缓存这条路是公开的 —— 没填 Key 的人也要能拿到别人做好的结果，
// 所以它不能要求任何凭据。可那意味着**任何能读到缓存的人也不该能悄悄改掉它**：一条正文与摘要
// 对不上的条目，说明写入时发生的不是一次正常上传（库被直接改过、备份被换过、中间环节被动过）。
// 客户端拿摘要复查一遍就能把这种条目当「没有」，而不是把别人的主题当自己的用。
//
// 绑定的四样东西缺一不可：
//  - kind + key：摘要不能从一条挪到另一条上（防止把 A 歌的答案冒充成 B 歌的）；
//  - writer：同一份内容换个写入者写出来是另一个摘要，追责时能对上是谁写的那一版；
//  - verifyKey：客户端拿这把钥匙验，服务端换了钥匙就没人会认旧摘要；
//  - payload：内容本身，逐字节。

/** 服务端算摘要用的公钥标识 —— 与客户端 `src/services/foliaCloud.ts` 认的必须是同一个值。 */
export const CACHE_VERIFY_KEY = 'folia-cache-digest-v1';

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string => (
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
);

export const cacheDigest = async (input: {
  kind: string;
  key: string;
  writer: string;
  payloadJson: string;
  verifyKey?: string;
}): Promise<string> => {
  const canonical = JSON.stringify([
    input.verifyKey ?? CACHE_VERIFY_KEY,
    input.kind,
    input.key,
    input.writer,
    input.payloadJson,
  ]);
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
};
