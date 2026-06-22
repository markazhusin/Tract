package node

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// GetStream is a managed real-time backend used here purely as a BACKUP SIGNALING
// channel — a reserve for reliability/load when the Tract node path (HTTP polling
// / SSE) is unavailable or saturated. Clients exchange the same offer/answer/ICE
// and app_packets over a Stream channel instead of (or in addition to) a node.
//
// SECURITY: the Stream API SECRET can mint a token for ANY user, so it lives ONLY
// on the node and is never embedded in a client binary. The node mints a short,
// per-user JWT on request; clients use that token + the (public) API key. Override
// per-deploy with STREAM_API_KEY / STREAM_API_SECRET / STREAM_APP_ID; clearing
// STREAM_API_SECRET disables the feature.
const (
	streamAPIKey    = "8pt33s7k243a"
	streamAPISecret = ""
	streamAppID     = "1644225"
)

func streamConfig() (apiKey, secret, appID string, enabled bool) {
	apiKey = envOr("STREAM_API_KEY", streamAPIKey)
	secret = envOr("STREAM_API_SECRET", streamAPISecret)
	appID = envOr("STREAM_APP_ID", streamAppID)
	return apiKey, secret, appID, secret != "" && apiKey != ""
}

// streamUserID sanitises a Tract userId to Stream's allowed id charset
// (a-z 0-9 @ _ -). Our ids are like "@abcd…" which already qualify.
func streamUserID(userId string) string {
	userId = strings.ToLower(strings.TrimSpace(userId))
	var b strings.Builder
	for _, r := range userId {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '@', r == '_', r == '-':
			b.WriteRune(r)
		}
	}
	s := b.String()
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

// mintStreamToken builds a Stream user JWT (HS256) signed with the API secret.
func mintStreamToken(secret, userID string) (string, error) {
	header := map[string]interface{}{"alg": "HS256", "typ": "JWT"}
	claims := map[string]interface{}{
		"user_id": userID,
		"iat":     time.Now().Unix(),
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(hb) + "." + enc.EncodeToString(cb)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	sig := enc.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig, nil
}

// handleGetStreamConfig advertises whether the backup signaling is available and
// the PUBLIC parameters a client needs (never the secret).
func handleGetStreamConfig(c *gin.Context) {
	apiKey, _, appID, enabled := streamConfig()
	c.JSON(200, gin.H{
		"enabled": enabled,
		"apiKey":  apiKey,
		"appId":   appID,
	})
}

// handleGetStreamToken mints a per-user Stream JWT so the client can use Stream as
// a backup signaling transport. GET /getstream/token?userId=@xxxx
func handleGetStreamToken(c *gin.Context) {
	apiKey, secret, appID, enabled := streamConfig()
	if !enabled {
		c.JSON(200, gin.H{"enabled": false})
		return
	}
	uid := streamUserID(c.Query("userId"))
	if uid == "" {
		c.JSON(400, gin.H{"error": "userId is required"})
		return
	}
	token, err := mintStreamToken(secret, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{
		"enabled": true,
		"apiKey":  apiKey,
		"appId":   appID,
		"userId":  uid,
		"token":   token,
	})
}
