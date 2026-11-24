local c=redis.call('HMGET',KEYS[1],'kh','st','a','d') local att,now=tonumber(ARGV[3]),tonumber(ARGV[4])
if c[1] then
  if c[1]~=ARGV[1] then return {'keymismatch'} end
  local a=tonumber(c[3]) local lost=c[2]=='running' and now>tonumber(c[4])+tonumber(ARGV[9])
  if not ((c[2]=='rejected' and att==a) or ((c[2]=='failed' or lost) and att==a+1)) then return {'duplicate',c[2]} end
  if lost then redis.call('ZREM',KEYS[5],ARGV[11]..':'..c[3]) end
end
local o=tonumber(redis.call('GET',KEYS[4]) or '') local cap=tonumber(ARGV[8]) if o then cap=math.max(0,math.min(o,12)) end
local function rej(code) redis.call('HSET',KEYS[1],'kh',ARGV[1],'m',ARGV[2],'st','rejected','a',att,'c',now,'e',code) redis.call('EXPIRE',KEYS[1],ARGV[13]) end
if cap==0 then rej('{"code":"STH-JOB-503"}') return {'off'} end
local total,mine=0,0
for i=5,#KEYS do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now) local n=redis.call('ZCARD',KEYS[i]) total=total+n if i==5 then mine=n end end
if total>=cap or mine>=tonumber(ARGV[7]) then rej('{"code":"STH-JOB-429"}') redis.call('HINCRBY',KEYS[3],'busy',1) redis.call('EXPIRE',KEYS[3],2592000) return {'busy'} end
if c[1] then redis.call('HDEL',KEYS[1],'f','fa','rb') end
redis.call('HSET',KEYS[1],'kh',ARGV[1],'m',ARGV[2],'st','running','a',att,'s',now,'d',ARGV[5],'x',ARGV[10],'e','')
redis.call('HSETNX',KEYS[1],'c',now) redis.call('EXPIRE',KEYS[1],ARGV[6])
redis.call('ZADD',KEYS[5],tonumber(ARGV[5])+tonumber(ARGV[9]),ARGV[11]..':'..att) redis.call('EXPIRE',KEYS[5],86400)
redis.call('SET',KEYS[2],ARGV[11]..'|'..att..'|'..ARGV[2],'EX',ARGV[12])
redis.call('HINCRBY',KEYS[3],'admitted',1) redis.call('EXPIRE',KEYS[3],2592000)
return {'admitted'}
