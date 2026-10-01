#!/bin/sh
# One-shot MinIO setup (compose service `minio-init`, image pgsty/mc). Idempotent: runs on every `up`.
#  - private bucket (no anonymous policy) with default SSE-S3 encryption (keys from MINIO_KMS_SECRET_KEY)
#  - a dedicated API user that can only read/write/delete objects in that bucket (the API never gets root)
# Root credentials arrive as env vars (MC_HOST_local), never as command-line arguments.
set -eu

: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}" "${BUCKET:?}" "${API_ACCESS_KEY:?}" "${API_SECRET_KEY:?}"
export MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000"

mc mb --ignore-existing "local/${BUCKET}"
mc anonymous set none "local/${BUCKET}"
mc encrypt set sse-s3 "local/${BUCKET}"

cat > /tmp/sila-api-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET}"]
    }
  ]
}
JSON
mc admin policy create local sila-api /tmp/sila-api-policy.json
# `user add` on an existing user updates its secret, so rotating S3_SECRET_KEY only needs a restart.
mc admin user add local "${API_ACCESS_KEY}" "${API_SECRET_KEY}"
# attaching an already-attached policy succeeds (the image has no grep to check first)
mc admin policy attach local sila-api --user "${API_ACCESS_KEY}"

echo "bucket ${BUCKET}: private, SSE-S3 on; user ${API_ACCESS_KEY}: policy sila-api"
