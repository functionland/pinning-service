package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

var (
	manifests     = make(map[string]map[string]interface{})
	manifestsLock = sync.Mutex{}
)

func main() {
	http.HandleFunc("/account/seeded", func(w http.ResponseWriter, r *http.Request) {
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		response := map[string]string{
			"seed":    request["seed"],
			"account": "5DV7iEBqaRLtZ4z33iHKq2sFJhCCirYUCbSs2GkCCaA25H1u",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	})

	http.HandleFunc("/account/balance", func(w http.ResponseWriter, r *http.Request) {
		response := map[string]int64{
			"amount": 9999999999999,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	})

	http.HandleFunc("/account/set_balance", func(w http.ResponseWriter, r *http.Request) {
		response := map[string]bool{
			"success": true,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	})

	http.HandleFunc("/fula/manifest/batch_upload", func(w http.ResponseWriter, r *http.Request) {
		var request map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		cidList, ok := request["cid"].([]interface{})
		if !ok || len(cidList) == 0 {
			http.Error(w, "Invalid CID list", http.StatusBadRequest)
			return
		}
		cid := cidList[0].(string)

		manifestsLock.Lock()
		manifests[cid] = map[string]interface{}{
			"cid":                   cid,
			"replication_available": 6,
		}
		manifestsLock.Unlock()

		response := map[string]string{
			"message":     "Success",
			"description": "Manifest created",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	})

	http.HandleFunc("/fula/manifest/available_batch", func(w http.ResponseWriter, r *http.Request) {
		var request map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		cidList, ok := request["cids"].([]interface{})
		if !ok || len(cidList) == 0 {
			http.Error(w, "Invalid CID list", http.StatusBadRequest)
			return
		}
		cid := cidList[0].(string)

		manifestsLock.Lock()
		defer manifestsLock.Unlock()
		if manifest, found := manifests[cid]; found {
			response := map[string]interface{}{
				"manifests": []map[string]interface{}{
					manifest,
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
		} else {
			response := map[string]interface{}{
				"manifests": []map[string]interface{}{},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
		}
	})

	http.HandleFunc("/fula/manifest/remove", func(w http.ResponseWriter, r *http.Request) {
		var request map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		response := map[string]string{
			"message":     "Success",
			"description": "Manifest removed",
		}

		cidList, ok := request["cid"].([]interface{})
		if !ok || len(cidList) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
		} else {
			cid := cidList[0].(string)

			manifestsLock.Lock()
			delete(manifests, cid)
			manifestsLock.Unlock()

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
		}
	})

	fmt.Println("Mock blockchain server is running on port 4000")
	http.ListenAndServe(":4000", nil)
}
