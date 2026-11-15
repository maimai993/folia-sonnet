// test/manual/rhineBootClock.mjs
//
// 把 bundle 的开屏时钟逻辑抽出来单独跑，确认 Cb(n) 的 n 到底怎么走。
//
// 逻辑来自 index-BJkD9xZ4.js：
//   ic = 22.76
//   boot 阶段：!Sf && e-Gi>=ic && (Sf=!0, Co||(eo=e, Gi=e-ic))
//   之后：eo!==null && (Co ? (Gi+=e-eo, eo=null) : Gi=e-ic)
//   n = rr ?? e-Gi
//
// 跑：node test/manual/rhineBootClock.mjs
const ic = 22.76;

function run({ libraryAt, seconds, label }) {
    let Gi = 0;
    let Sf = false;
    let eo = null;
    let Co = false;
    const samples = [];
    for (let e = 0; e < seconds; e += 0.25) {
        // 曲库注入在这一刻完成
        if (!Co && e >= libraryAt) Co = true;
        if (!Sf && e - Gi >= ic) {
            Sf = true;
            if (!Co) { eo = e; Gi = e - ic; }
        }
        if (eo !== null) {
            if (Co) { Gi += e - eo; eo = null; } else { Gi = e - ic; }
        }
        const n = e - Gi;
        samples.push([Number(e.toFixed(2)), Number(n.toFixed(2))]);
    }
    // 找 n 是否出现回退（开屏重来）
    let regressions = 0;
    for (let i = 1; i < samples.length; i += 1) {
        if (samples[i][1] < samples[i - 1][1] - 0.01) regressions += 1;
    }
    const last = samples[samples.length - 1];
    const reached35 = samples.some(([, n]) => n >= 35);
    console.log(`${label}: 库注入@${libraryAt}s -> 末尾 n=${last[1]}, 回退次数=${regressions}, 到达35=${reached35}`);
    return { regressions, lastN: last[1], reached35 };
}

console.log('n 是开屏时间轴（秒）；>=22 出 SELECTING，>=35 进 detail');
console.log('');
run({ libraryAt: 1, seconds: 40, label: 'A 曲库很快(1s)  ' });
run({ libraryAt: 5, seconds: 40, label: 'B 曲库5s       ' });
run({ libraryAt: 30, seconds: 60, label: 'C 曲库很慢(30s)' });
run({ libraryAt: 999, seconds: 70, label: 'D 曲库永不到   ' });
