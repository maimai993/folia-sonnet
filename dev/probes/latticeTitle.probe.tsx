import type { ProbeDefinition } from './definition';
import '../../src/components/app/lattice/Lattice.css';

// Isolated mixed-font titles at the compact line spacing used by expanded posters.
function LatticeTitleProbe() {
    return <div style={{ color: 'white', background: '#243748', padding: 40 }}>
        {['壤土下的安居 Cozy Home Underground', '锤砧间的音符 Notes From Striking the Anvil', '新月的摇篮曲（其三）：眉间落英 Lullaby of the New Moon'].map(title => (
            <div key={title} className="lattice-poster-copy" style={{ position: 'relative', width: 430, inset: 'auto', marginBottom: 60 }}>
                <strong>{title}</strong>
                <small>HOYO-MiX</small>
            </div>
        ))}
        <style>{'.lattice-poster-copy strong { font-size: 70.7625px; }'}</style>
    </div>;
}

export default {
    id: 'latticeTitle', title: 'Lattice title clipping',
    description: 'Mixed CJK and Latin glyphs, tight line spacing and three-line truncation.',
    Component: LatticeTitleProbe,
} satisfies ProbeDefinition;
