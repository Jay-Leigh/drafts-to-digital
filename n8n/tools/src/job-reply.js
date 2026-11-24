// Background jobs: fixed answers that need no Redis (hello, bad request).
return [{ json: $input.first().json.reply }];
