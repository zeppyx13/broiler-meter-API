// Registry provenance comes from persisted source evidence, never names or UID prefixes.
// All callers use the fixed device alias `d`; this fragment contains no request input.
const realEvidence = `(
  EXISTS (SELECT 1 FROM meters pm JOIN meter_readings pr ON pr.meter_id = pm.id
          WHERE pm.device_id = d.id AND pr.source IN ('mqtt', 'http'))
  OR EXISTS (SELECT 1 FROM coop_live_status pl
             WHERE pl.coop_id = d.coop_id AND pl.device_id = d.id AND pl.source = 'sensor')
)`;
const simulationEvidence = `(
  EXISTS (SELECT 1 FROM meters sm JOIN meter_readings sr ON sr.meter_id = sm.id
          WHERE sm.device_id = d.id AND sr.source = 'simulation')
  OR EXISTS (SELECT 1 FROM coop_live_status sl
             WHERE sl.coop_id = d.coop_id AND sl.device_id = d.id AND sl.source = 'simulation')
)`;

module.exports = `CASE
  WHEN ${realEvidence} THEN CASE WHEN ${simulationEvidence} THEN 'mixed' ELSE 'real' END
  WHEN ${simulationEvidence} THEN 'simulation'
  ELSE 'no_data' END AS data_provenance`;
