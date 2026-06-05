export const TAU = Math.PI * 2;
export const WEDGE_COUNT = 12;
export const WEDGE_ANGLE = TAU / WEDGE_COUNT;

export const geometry = {
  planetRadiusRatio: 0.18,
  holeRadiusRatio: 0.34,
  divideRadiusRatio: 0.62,
  outerRadiusRatio: 1
};

export const wedges = [
  { major: "C", majorFile: "C.ogg", majorSemitone: 0, minor: "Am", minorFile: "Am.ogg", minorSemitone: 9 },
  { major: "G", majorFile: "G.ogg", majorSemitone: 7, minor: "Em", minorFile: "Em.ogg", minorSemitone: 4 },
  { major: "D", majorFile: "D.ogg", majorSemitone: 2, minor: "Bm", minorFile: "Bm.ogg", minorSemitone: 11 },
  { major: "A", majorFile: "A.ogg", majorSemitone: 9, minor: "F#m", minorFile: "Fsharpm.ogg", minorSemitone: 6 },
  { major: "E", majorFile: "E.ogg", majorSemitone: 4, minor: "C#m", minorFile: "Csharpm.ogg", minorSemitone: 1 },
  { major: "B", majorFile: "B.ogg", majorSemitone: 11, minor: "G#m", minorFile: "Gsharpm.ogg", minorSemitone: 8 },
  { major: "Gb", majorFile: "Gb.ogg", majorSemitone: 6, minor: "Ebm", minorFile: "Ebm.ogg", minorSemitone: 3 },
  { major: "Db", majorFile: "Db.ogg", majorSemitone: 1, minor: "Bbm", minorFile: "Bbm.ogg", minorSemitone: 10 },
  { major: "Ab", majorFile: "Ab.ogg", majorSemitone: 8, minor: "Fm", minorFile: "Fm.ogg", minorSemitone: 5 },
  { major: "Eb", majorFile: "Eb.ogg", majorSemitone: 3, minor: "Cm", minorFile: "Cm.ogg", minorSemitone: 0 },
  { major: "Bb", majorFile: "Bb.ogg", majorSemitone: 10, minor: "Gm", minorFile: "Gm.ogg", minorSemitone: 7 },
  { major: "F", majorFile: "F.ogg", majorSemitone: 5, minor: "Dm", minorFile: "Dm.ogg", minorSemitone: 2 }
];

const loopDurations = {
  "major/C.ogg": 74.2936875,
  "major/D.ogg": 74.94385416666667,
  "major/G.ogg": 74.2936875
};

const availableAudioStems = new Set([
  "audio/major/C",
  "audio/major/D",
  "audio/major/G"
]);

export const regions = [
  ...wedges.map((wedge, wedgeIndex) => ({
    index: wedgeIndex,
    wedgeIndex,
    ring: "major",
    orbit: "high",
    name: wedge.major,
    label: `${wedge.major} major`,
    display: wedge.major,
    semitone: wedge.majorSemitone,
    loopDuration: loopDurations[`major/${wedge.majorFile}`] || null,
    audioSources: audioSourcesFor("major", wedge.majorFile)
  })),
  ...wedges.map((wedge, wedgeIndex) => ({
    index: WEDGE_COUNT + wedgeIndex,
    wedgeIndex,
    ring: "minor",
    orbit: "low",
    name: wedge.minor,
    label: `${wedge.minor} minor`,
    display: wedge.minor,
    semitone: wedge.minorSemitone,
    loopDuration: loopDurations[`minor/${wedge.minorFile}`] || null,
    audioSources: audioSourcesFor("minor", wedge.minorFile)
  }))
];

function audioSourcesFor(ring, file) {
  const stem = file.replace(/\.[^.]+$/, "");
  const base = `audio/${ring}/${stem}`;
  if (!availableAudioStems.has(base)) {
    return [];
  }

  return [
    { src: `${base}.webm`, type: "audio/webm; codecs=\"opus\"" },
    { src: `${base}.ogg`, type: "audio/ogg; codecs=\"vorbis\"" },
    { src: `${base}.m4a`, type: "audio/mp4; codecs=\"mp4a.40.2\"" },
    { src: `${base}.mp3`, type: "audio/mpeg" }
  ];
}

export function regionIndex(ring, wedgeIndex) {
  const normalized = ((wedgeIndex % WEDGE_COUNT) + WEDGE_COUNT) % WEDGE_COUNT;
  return ring === "major" ? normalized : WEDGE_COUNT + normalized;
}

export function regionFor(ring, wedgeIndex) {
  return regions[regionIndex(ring, wedgeIndex)];
}

export function normalizeAngle(angle) {
  return ((angle % TAU) + TAU) % TAU;
}

export function ringDisplay(ring) {
  return ring === "major" ? "Major" : "Minor";
}
