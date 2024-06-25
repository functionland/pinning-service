package openapi

import (
	"github.com/gorilla/mux"
)

func NewAdditionalRouter(pinsAPIController *PinsAPIController, userAPIController *UserAPIController) *mux.Router {
	router := mux.NewRouter().StrictSlash(true)

	// User authentication routes
	router.HandleFunc("/auth/token", userAPIController.CreateSession).Methods("POST")
	router.HandleFunc("/auth/token", userAPIController.DeleteSession).Methods("DELETE")

	return router
}
