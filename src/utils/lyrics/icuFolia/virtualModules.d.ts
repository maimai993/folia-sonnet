// src/utils/lyrics/icuFolia/virtualModules.d.ts
// jieba's dictionary and HMM tables reach icu-folia as binary files built by
// dev/icuFolia/icuFoliaDataPlugin.mjs; the virtual modules hand over their URLs. TS has no real
// file to resolve and needs these declarations.

declare module 'virtual:icu-folia-dict' {
    /** URL of the binary dictionary; fetch it and decode with decodeJiebaDict (jiebaData.ts). */
    const url: string;
    export default url;
}

declare module 'virtual:icu-folia-hmm' {
    /** URL of the binary HMM tables; fetch it and decode with decodeJiebaHmm (jiebaData.ts). */
    const url: string;
    export default url;
}
