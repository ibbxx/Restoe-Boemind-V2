-- Accept dynamic snapshots while retaining v2 history and the existing identity checks.
alter table procurement.workbook_snapshots
  drop constraint workbook_snapshots_check,
  add constraint workbook_snapshots_check check ((
    (payload->'schemaVersion' = '2'::jsonb or
      (payload->'schemaVersion' = '3'::jsonb and jsonb_typeof(payload->'workbook') = 'object'))
    and (payload->>'id')::uuid = id and (payload->>'analysisId')::uuid = analysis_id
    and (payload->'project') ?& array['id','name']
    and (payload#>>'{project,id}')::uuid = (payload->>'projectId')::uuid
    and (payload->'analysis') ?& array['analysis','vendors','offers','offerRevisions']
    and (payload#>'{analysis,analysis}') ?& array['id','projectId','name']
    and (payload#>>'{analysis,analysis,id}')::uuid = analysis_id
    and (payload#>>'{analysis,analysis,projectId}')::uuid = (payload->>'projectId')::uuid
    and (payload->'profiles') ?& array['INU','SOLAR_BAWAH']
    and (payload->'policy') ? 'status'
  ) is true);
