package org.remotecontrol.share;

import android.util.Base64;
import org.json.JSONObject;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** An attended, view-only Android capture session. Keys stay on the devices. */
final class InternetHost extends WebSocketListener implements AutoCloseable {
    static final String DEFAULT = "https://remote.uniway-tw.com";
    private static final SecureRandom random = new SecureRandom();
    private final byte[] seed = randomBytes(24);
    private final Map<Integer, Peer> peers = new LinkedHashMap<>();
    private final OkHttpClient client = new OkHttpClient.Builder().pingInterval(22,TimeUnit.SECONDS).build();
    private final Consumer<String> stopped;
    private final String base;
    private WebSocket socket;
    private boolean closed, ready;

    InternetHost(String address, Consumer<String> stopped) {
        URI uri = URI.create(address);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null
                || uri.getQuery()!=null || uri.getFragment()!=null) throw new IllegalArgumentException("請填入 HTTPS 配對服務網址。");
        base=uri.toASCIIString().replaceFirst("/+$","");
        this.stopped=stopped;
    }
    synchronized void start() {
        socket=client.newWebSocket(new Request.Builder().url(base+"/v1/session").build(),this);
    }
    synchronized String status() {
        if (!ready) return "正在連接跨網路配對服務…";
        return "跨網路邀請碼\n"+invitation()+"\n\n將邀請碼交給觀看者，再核准下方的請求。\n觀看中："+viewers();
    }
    synchronized String invitation() { return ready ? "rc1."+b64(base.getBytes(StandardCharsets.US_ASCII))+"."+b64(seed) : ""; }
    synchronized Map<Integer,String> pending() {
        Map<Integer,String> result=new LinkedHashMap<>();
        for (Peer p:peers.values()) if (p.name!=null && !p.approved) result.put(p.id,p.name);
        return result;
    }
    synchronized int viewers() { int count=0;for(Peer p:peers.values()) if(p.approved) count++;return count; }
    synchronized void decide(int id, boolean allow) {
        Peer p=peers.get(id); if(p==null || p.name==null || p.approved) return;
        try {
            if(allow) {
                p.approved=true;
                send(p,1,new JSONObject().put("t","approved").put("control",false).toString().getBytes(StandardCharsets.UTF_8));
            } else drop(id);
        } catch(Exception e) { drop(id); }
    }
    synchronized void publish(byte[] jpeg) {
        if(closed || socket==null || socket.queueSize()>420000 || jpeg.length>340000) return;
        for(Peer p:peers.values().toArray(new Peer[0])) if(p.approved) {
            try { send(p,2,jpeg); } catch(Exception e) { drop(p.id); }
        }
    }
    @Override public synchronized void onOpen(WebSocket ws, Response response) {
        if(closed) return;
        try {
            String room=hex(MessageDigest.getInstance("SHA-256").digest(seed)).substring(0,32);
            ws.send(new JSONObject().put("room",room).put("role","host").toString());
        } catch(Exception e) { end(); }
    }
    @Override public synchronized void onMessage(WebSocket ws,String text) {
        if(closed || text.length()>1024) return;
        try {
            JSONObject m=new JSONObject(text);
            String t=m.getString("t");
            if(t.equals("ready")) { ready=true;return; }
            int id=(int)m.getLong("id");
            if(t.equals("left")) { peers.remove(id);return; }
            if(!t.equals("join") || peers.size()>=8 || peers.containsKey(id)) return;
            byte[] host=randomBytes(16);
            byte[] viewer=unhex(m.getString("nonce"));
            byte[] salt=ByteBuffer.allocate(32).put(host).put(viewer).array();
            byte[] prk=hmac(salt,seed);
            Peer p=new Peer(id,derive(prk,"share"),derive(prk,"view"));
            peers.put(id,p);
            ws.send(new JSONObject().put("t","hello").put("id",Integer.toUnsignedLong(id)).put("nonce",hex(host)).toString());
        } catch(Exception e) { end(); }
    }
    @Override public synchronized void onMessage(WebSocket ws,ByteString message) {
        if(closed || message.size()<21 || message.size()>2048) return;
        ByteBuffer packet=message.asByteBuffer();
        int id=packet.getInt();Peer p=peers.get(id);if(p==null)return;
        try {
            byte[] ciphertext=new byte[packet.remaining()];packet.get(ciphertext);
            byte[] data=crypt(Cipher.DECRYPT_MODE,p.rx,p.incoming++,ciphertext);
            if(data[0]!=1) { drop(id);return; }
            JSONObject m=new JSONObject(new String(data,1,data.length-1,StandardCharsets.UTF_8));
            if("request".equals(m.optString("t")) && p.name==null) {
                String name=m.getString("name").trim();
                if(name.isEmpty() || name.length()>64) { drop(id);return; }
                p.name=name;
            }
        } catch(Exception e) { drop(id); }
    }
    @Override public synchronized void onFailure(WebSocket ws,Throwable t,Response r) {end();}
    @Override public synchronized void onClosing(WebSocket ws,int code,String reason) {ws.close(code,null);end();}
    private void end() { if(!closed){close();stopped.accept("配對服務已離線，請確認網路並重新分享。");} }
    private void drop(int id) {
        peers.remove(id);
        try {socket.send(new JSONObject().put("t","drop").put("id",Integer.toUnsignedLong(id)).toString());}
        catch(Exception ignored) {end();}
    }
    private void send(Peer p,int type,byte[] data) throws Exception {
        byte[] plain=ByteBuffer.allocate(1+data.length).put((byte)type).put(data).array();
        byte[] bytes=crypt(Cipher.ENCRYPT_MODE,p.tx,p.outgoing++,plain);
        if(!socket.send(ByteString.of(ByteBuffer.allocate(4+bytes.length).putInt(p.id).put(bytes).array()))) end();
    }
    @Override public synchronized void close() {
        if(closed)return;closed=true;ready=false;peers.clear();
        if(socket!=null) socket.cancel();
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }
    private static final class Peer {
        final int id;final byte[] tx,rx; long outgoing,incoming;boolean approved;String name;
        Peer(int id,byte[] tx,byte[] rx){this.id=id;this.tx=tx;this.rx=rx;}
    }
    private static byte[] crypt(int mode,byte[] key,long seq,byte[] data) throws Exception {
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv=ByteBuffer.allocate(12).putInt(0).putLong(seq).array();
        c.init(mode,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));return c.doFinal(data);
    }
    private static byte[] hmac(byte[] key,byte[] input) throws Exception {
        Mac m=Mac.getInstance("HmacSHA256");m.init(new SecretKeySpec(key,"HmacSHA256"));return m.doFinal(input);
    }
    private static byte[] derive(byte[] prk,String direction) throws Exception {
        return hmac(prk,("remote-control/v1/"+direction+"\u0001").getBytes(StandardCharsets.UTF_8));
    }
    private static String b64(byte[] b){return Base64.encodeToString(b,Base64.NO_WRAP|Base64.NO_PADDING|Base64.URL_SAFE);}
    private static byte[] randomBytes(int n){byte[] b=new byte[n];random.nextBytes(b);return b;}
    private static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte x:b)s.append(String.format(java.util.Locale.ROOT,"%02x",x));return s.toString();}
    private static byte[] unhex(String s){
        if(!s.matches("[a-f0-9]{32}"))throw new IllegalArgumentException();
        byte[] b=new byte[16];for(int i=0;i<16;i++)b[i]=(byte)Integer.parseInt(s.substring(2*i,2*i+2),16);return b;
    }
}
