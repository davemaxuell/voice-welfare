/** 공공데이터포털에서 미리 내려받은 복지사업과 기관 자료. */
import { PLACE_KINDS, type PlaceKind } from "../../../core/places.ts";
import { BUNDLED, DATASETS, datasetStatus, loadOne, type DatasetStatus, type Place } from "./datasets.ts";
import { ServiceLinkShelf } from "./links.ts";
import { officialDistricts, PlaceFinder, PlaceReply } from "./places.ts";
import { ProgramShelf, type PrivateProgramEntry } from "./programs.ts";

export { PlaceFinder, PlaceReply, ProgramShelf, ServiceLinkShelf, officialDistricts };
export type { DatasetStatus, PrivateProgramEntry };

export class OpenData {
  readonly programs: ProgramShelf;
  readonly places: PlaceFinder;
  readonly statuses: readonly DatasetStatus[];
  readonly links: ServiceLinkShelf;

  constructor(programs: ProgramShelf, places: PlaceFinder, statuses: readonly DatasetStatus[], links = new ServiceLinkShelf()) {
    this.programs = programs;
    this.places = places;
    this.statuses = statuses;
    this.links = links;
  }

  static empty(): OpenData {
    const missing = [...DATASETS.keys()].map(id => datasetStatus(id, { error: "missing" }));
    return new OpenData(new ProgramShelf(), new PlaceFinder(new Map(), new Map()), missing, new ServiceLinkShelf());
  }

  static load(folder?: string): OpenData {
    const where = folder ?? BUNDLED;
    const statuses: DatasetStatus[] = [];
    const rows = new Map<PlaceKind, readonly Place[]>();
    const dates = new Map<PlaceKind, string>();
    let programs = new ProgramShelf();
    let links = new ServiceLinkShelf();
    for (const spec of DATASETS.values()) {
      switch (spec.id) {
        case "15116392": {
          const [status, records] = loadOne(where, spec);
          statuses.push(status);
          if (status.error === null && status.reference_date !== null) programs = new ProgramShelf(records, status.reference_date);
          break;
        }
        case "15083323": {
          const [status, records] = loadOne(where, spec);
          statuses.push(status);
          if (status.error === null && status.reference_date !== null) links = new ServiceLinkShelf(records, status.reference_date);
          break;
        }
        case PLACE_KINDS.DONG_OFFICE:
        case PLACE_KINDS.PENSION:
        case PLACE_KINDS.MOBILITY: {
          const [status, records] = loadOne(where, spec);
          statuses.push(status);
          if (status.error === null && status.reference_date !== null) {
            rows.set(spec.id, records);
            dates.set(spec.id, status.reference_date);
          }
          break;
        }
        default: {
          const unreachable: never = spec;
          throw new Error(`알 수 없는 자료: ${JSON.stringify(unreachable)}`);
        }
      }
    }
    return new OpenData(programs, new PlaceFinder(rows, dates), statuses, links);
  }
}
