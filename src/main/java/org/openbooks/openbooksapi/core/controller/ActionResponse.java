package org.openbooks.openbooksapi.core.controller;

public class ActionResponse {

	private String message;

	public ActionResponse() {}
	
	public ActionResponse(String message) {
		this.message = message;
	}

	public String getMessage() {
		return message;
	}

	public void setMessage(String message) {
		this.message = message;
	}
	
	
}
