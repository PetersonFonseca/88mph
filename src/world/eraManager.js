import { MaterialLibrary } from './materials.js';
import { seededRandom } from '../core/rng.js';
import { layout } from './layout.js';
import { build as present } from './eras/present.js';
import { build as fifties } from './eras/fifties.js';
import { build as oldwest } from './eras/oldwest.js';
import { build as future } from './eras/future.js';

export const ERA_NAMES = { present: 'Presente', fifties: 'Anos 50', oldwest: 'Velho Oeste', future: 'Futuro' };
const builders = { present, fifties, oldwest, future };
export class EraManager {
  constructor(scene) { this.scene = scene; this.materials = new MaterialLibrary(); this.current = null; this.prepared = new Set(); }
  async prepare(era, date) {
    if (!builders[era]) throw new Error(`Época desconhecida: ${era}`);
    const hour = date.hour + date.minute / 60;
    const ctx = { date: { ...date }, hour, isNight: hour < 6 || hour >= 18, wet: era === 'present', rng: seededRandom(`${era}:${date.year}`), layout, materials: this.materials };
    const built = builders[era](ctx); this.prepared.add(built); return built;
  }
  activate(built) {
    if (built === this.current) return built;
    this.current?.dispose(); this.prepared.delete(built); this.current = built;
    this.scene.add(built.group); return built;
  }
  discard(built) { if (built && built !== this.current) { built.dispose(); this.prepared.delete(built); } }
  update(dt, time, position) { this.current?.update(dt, time, position); }
  dispose() { this.current?.dispose(); for (const era of this.prepared) era.dispose(); this.prepared.clear(); this.materials.dispose(); this.current = null; }
}
