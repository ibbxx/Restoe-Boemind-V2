begin;

-- Repair only the original seeded records; a newer saved version is left untouched.
update procurement.current_workbooks
set data = jsonb_set(data, '{state,policy,versionId}', data #> '{configuration,policyVersionId}'),
    version = gen_random_uuid(), saved_at = now(), mutation_id = gen_random_uuid(),
    request_signature = repeat('0', 64)
where project_id = '11111111-1111-4111-8111-111111111111'
  and analysis_id in ('f232393a-7ba1-4ad6-8f84-5f4767b1fcd4',
    '796580b4-86b9-4b81-a63d-c3bf27dfd088', '34bc1538-40e3-465c-af04-028ab2db4a9f')
  and version = '22222222-2222-4222-8222-222222222222'
  and data #>> '{state,policy,status}' = 'CONFIGURED'
  and data #>> '{configuration,policyVersionId}' = '4dec1880-3c0e-4b26-9a3d-0f69e3347d18'
  and data #>> '{state,policy,versionId}' is distinct from data #>> '{configuration,policyVersionId}'
returning analysis_id, data #>> '{state,policy,versionId}' as policy_version;

commit;
