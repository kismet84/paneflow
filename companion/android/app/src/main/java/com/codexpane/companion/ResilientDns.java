package com.codexpane.companion;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.*;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import org.json.*;

/** Uses ordinary DNS first; HTTPS fallback sends only a hostname, never pairing or chat data. */
final class ResilientDns implements Dns {
    private final OkHttpClient resolver = new OkHttpClient.Builder().dns(Dns.SYSTEM)
        .connectTimeout(4,TimeUnit.SECONDS).readTimeout(4,TimeUnit.SECONDS).callTimeout(6,TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();
    @Override public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        try { return preferIpv4(Dns.SYSTEM.lookup(hostname)); }
        catch (UnknownHostException original) {
            if (!hostname.contains(".") || hostname.endsWith(".local") || hostname.equals("localhost")) throw original;
            for (String endpoint : new String[]{"https://dns.alidns.com/resolve", "https://cloudflare-dns.com/dns-query"}) {
                try {
                    HttpUrl url=HttpUrl.get(endpoint).newBuilder().addQueryParameter("name",hostname).addQueryParameter("type","A").build();
                    try(Response response=resolver.newCall(new Request.Builder().url(url).header("Accept","application/dns-json").build()).execute()) {
                        if(!response.isSuccessful()||response.body()==null)continue;
                        String body=response.peekBody(32769).string();if(body.length()>32768)continue;
                        JSONObject json=new JSONObject(body);if(json.optInt("Status",-1)!=0)continue;
                        JSONArray answers=json.optJSONArray("Answer");List<InetAddress> addresses=new ArrayList<>();
                        if(answers!=null)for(int i=0;i<Math.min(answers.length(),32);i++){
                            JSONObject answer=answers.optJSONObject(i);if(answer==null||answer.optInt("type")!=1)continue;
                            String ip=answer.optString("data");String[] parts=ip.split("\\.");if(parts.length!=4)continue;
                            byte[] bytes=new byte[4];boolean valid=true;
                            for(int n=0;n<4;n++){if(!parts[n].matches("[0-9]{1,3}")){valid=false;break;}int number=Integer.parseInt(parts[n]);if(number>255){valid=false;break;}bytes[n]=(byte)number;}
                            if(valid)addresses.add(InetAddress.getByAddress(hostname,bytes));
                        }
                        if(!addresses.isEmpty()){android.util.Log.i("PaneFlowConnection","HTTPS DNS fallback resolved");return addresses;}
                    }
                }catch(Exception ignored){ /* Try the next TLS-validated resolver, then keep normal retry behavior. */ }
            }
            throw original;
        }
    }

    // Some mobile networks advertise IPv6 routes that stall socket connection.
    // Keep every address (including IPv6-only hosts), but try IPv4 first when both exist.
    static List<InetAddress> preferIpv4(List<InetAddress> addresses) {
        List<InetAddress> ordered=new ArrayList<>(addresses);
        ordered.sort(Comparator.comparingInt(address->address instanceof java.net.Inet4Address?0:1));
        return ordered;
    }
}
