frappe.ui.form.on('Die Database', {
	die_request(frm) {
		frappe.call({
		    method:"frappe.client.get",
		    args:{
		        "doctype":"Die Request",
		        "name":frm.doc.die_request
		        },
		    callback:function(r){
		        if(r.message){
		            frm.set_value("characteristics",r.message.characteristic_details)
		            frm.set_value("characteristics_2",r.message.characteristic_details_2)
		        }
		    }
		})
	}
})